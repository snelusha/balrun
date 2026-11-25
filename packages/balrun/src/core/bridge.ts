import { createHTTPListenerTransport } from "./http-listener";

import type {
	BallerinaCore,
	BallerinaInterpreterVersion,
	BallerinaRunOptions,
	BallerinaRunResult,
	BallerinaStopMode,
} from "./ballerina-core";
import type { Fs } from "./fs";
import type {
	HTTPDispatchRequest,
	HTTPListenerReady,
	HTTPListenerRequest,
	HTTPListenerResponse,
	HTTPListenerTransport,
} from "./http-listener";
import type { OSPlatform } from "./os";
import type { Platform } from "./platform";

export type WasmSource = string | URL | Response | PromiseLike<Response>;

interface WasmPlatform {
	httpListenerTransport: HTTPListenerTransport;
	os: OSPlatform;
}

interface WasmRunOptions extends BallerinaRunOptions {
	platform: WasmPlatform;
}

export interface WasmExports {
	version: () => BallerinaInterpreterVersion;
	run(proxy: Fs, path: string, options?: WasmRunOptions): Promise<BallerinaRunResult>;
	stop: (mode: BallerinaStopMode) => boolean;
	dispatchHttpRequest: (
		host: string,
		port: number,
		request: HTTPListenerRequest,
	) => Promise<HTTPListenerResponse>;
}

type GoRuntime = Go & {
	_scheduledTimeouts?: Map<number, ReturnType<typeof setTimeout>>;
};

// Keep in sync with packages/ballerina-wasm/main_wasm.go.
const EXPORTS_KEY = "__balrun_exports__";

export class WasmBridge implements BallerinaCore {
	private exports: WasmExports = {} as WasmExports;
	private go: GoRuntime | null = null;

	private onListenerReady: ((listener: HTTPListenerReady) => void) | undefined;
	private activeRun = false;

	private readonly platform: Platform;
	private readonly httpListenerTransport: HTTPListenerTransport;

	constructor(platform: Platform) {
		this.platform = platform;
		this.httpListenerTransport = createHTTPListenerTransport(
			(listener, request) =>
				this.exports.dispatchHttpRequest(listener.host, listener.port, request),
			(listener) => this.onListenerReady?.(listener),
			platform.httpServer,
		);
	}

	async start(source: WasmSource = this.platform.wasm): Promise<this> {
		await import("./wasm_exec");
		const go = new Go();
		const instance = await instantiate(this.platform, source, go.importObject);
		this.exports = await startGo(go, instance);
		this.go = go;
		return this;
	}

	async version(): Promise<BallerinaInterpreterVersion> {
		return this.exports.version();
	}

	async run(proxy: Fs, path: string, options?: BallerinaRunOptions): Promise<BallerinaRunResult> {
		if (path === "") return Promise.reject(new Error("[balrun]: run path must not be empty."));
		if (path.startsWith("/") && !proxy.supportsAbsolutePaths)
			return Promise.reject(new Error("[balrun]: filesystem does not support absolute run paths."));
		if (this.activeRun) return Promise.reject(new Error("[balrun]: a run is already active."));
		const { onListenerReady, ...runOptions } = options ?? {};
		this.activeRun = true;
		this.onListenerReady = onListenerReady;
		try {
			return await this.exports.run(proxy, path, {
				...runOptions,
				platform: {
					httpListenerTransport: this.httpListenerTransport,
					os: this.platform.createOS(runOptions.env),
				},
			});
		} finally {
			this.activeRun = false;
			this.onListenerReady = undefined;
			this.clearScheduledTimeouts();
		}
	}

	stop(mode: BallerinaStopMode): boolean {
		return this.exports.stop(mode);
	}

	dispatchHttpRequest(request: HTTPDispatchRequest): Promise<HTTPListenerResponse> {
		return this.httpListenerTransport.dispatch(request);
	}

	private clearScheduledTimeouts(): void {
		// HTTP client timeouts leave Go WASM timers pending, which keeps Node alive.
		const timeouts = this.go?._scheduledTimeouts;
		if (!timeouts) return;

		for (const timeout of timeouts.values()) {
			clearTimeout(timeout);
		}
		timeouts.clear();
	}
}

async function startGo(go: Go, instance: WebAssembly.Instance): Promise<WasmExports> {
	const host = globalThis as { [EXPORTS_KEY]?: Partial<WasmExports> };
	const exports: Partial<WasmExports> = {};

	let running: Promise<void>;
	host[EXPORTS_KEY] = exports;
	try {
		running = go.run(instance);
	} finally {
		delete host[EXPORTS_KEY];
	}

	await Promise.race([running, Promise.resolve()]);
	if (!exports.run) throw new Error("[balrun]: the WASM module did not register its exports.");
	return exports as WasmExports;
}

async function instantiate(
	platform: Platform,
	source: WasmSource,
	importObject: WebAssembly.Imports,
): Promise<WebAssembly.Instance> {
	if (typeof source === "string" || source instanceof URL) {
		if (source === "") throw new Error("[balrun]: WASM source must not be empty.");
		const bytes = platform.readWasm?.(source);
		if (bytes) {
			const { instance } = await WebAssembly.instantiate(
				(await bytes) as Uint8Array<ArrayBuffer>,
				importObject,
			);
			return instance;
		}
		return instantiateResponse(fetch(source), importObject);
	}
	return instantiateResponse(source, importObject);
}

async function instantiateResponse(
	source: Response | PromiseLike<Response>,
	importObject: WebAssembly.Imports,
): Promise<WebAssembly.Instance> {
	const response = await source;
	if (!response.ok) {
		throw new Error(`[balrun]: failed to load WASM: ${response.status} ${response.statusText}`);
	}

	try {
		const { instance } = await WebAssembly.instantiateStreaming(response.clone(), importObject);
		return instance;
	} catch {
		const buffer = await response.arrayBuffer();
		const { instance } = await WebAssembly.instantiate(buffer, importObject);
		return instance;
	}
}
