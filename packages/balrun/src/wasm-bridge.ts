import type {
	BallerinaCore,
	BallerinaRunOptions,
	BallerinaRunResult,
	BallerinaStopMode,
} from "./ballerina-core";
import { createHTTPListenerTransport } from "./http-listener";

import type {
	HTTPDispatchRequest,
	HTTPListenerTransport,
	HTTPListenerReady,
	HTTPListenerRequest,
	HTTPListenerResponse,
} from "./http-listener";
import type { FS } from "./fs/core";

const NODE_FS_PROMISES_MODULE = "node:fs/promises";

interface WasmPlatform {
	httpListenerTransport: HTTPListenerTransport;
}

interface WasmRunOptions extends BallerinaRunOptions {
	platform: WasmPlatform;
}

export interface WasmExports {
	run(proxy: FS, path: string, options?: WasmRunOptions): Promise<BallerinaRunResult>;
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

export class WasmBridge implements BallerinaCore {
	private exports: WasmExports = {} as WasmExports;
	private go: GoRuntime | null = null;

	private onListenerReady: ((listener: HTTPListenerReady) => void) | undefined;
	private platform: WasmPlatform = {
		httpListenerTransport: createHTTPListenerTransport(
			(listener, request) =>
				this.exports.dispatchHttpRequest(listener.host, listener.port, request),
			(listener) => this.onListenerReady?.(listener),
		),
	};

	static async load(source: string | Response | PromiseLike<Response>): Promise<WasmBridge> {
		await import("./wasm_exec");
		const go = new Go();
		const instance = await loadWasm(source, go.importObject);
		go.run(instance);
		const bridge = new WasmBridge();
		bridge.go = go;
		// FIXME: `stop()` conflicts with DOM `window.stop()`
		bridge.exports = { ...globalThis } as unknown as WasmExports;
		return bridge;
	}

	run(proxy: FS, path: string, options?: BallerinaRunOptions): Promise<BallerinaRunResult> {
		if (path === "") return Promise.reject(new Error("[balrun]: run path must not be empty."));
		const { onListenerReady, ...runOptions } = options ?? {};
		this.onListenerReady = onListenerReady;
		return this.exports.run(proxy, path, { ...runOptions, platform: this.platform }).finally(() => {
			this.onListenerReady = undefined;
			this.clearScheduledTimeouts();
		});
	}

	stop(mode: BallerinaStopMode): boolean {
		return this.exports.stop(mode);
	}

	dispatchHttpRequest(request: HTTPDispatchRequest): Promise<HTTPListenerResponse> {
		return this.platform.httpListenerTransport.dispatch(request);
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

function loadWasm(
	source: string | Response | PromiseLike<Response>,
	importObject: WebAssembly.Imports,
): Promise<WebAssembly.Instance> {
	if (typeof source === "string") {
		if (source === "") return Promise.reject(new Error("[balrun]: WASM source must not be empty."));
		if (shouldFetch(source)) return loadRemote(source, importObject);
		else return loadLocal(source, importObject);
	} else {
		return loadFromResponse(source, importObject);
	}
}

async function loadRemote(
	url: string,
	importObject: WebAssembly.Imports,
): Promise<WebAssembly.Instance> {
	const response = await fetch(url);
	return loadFromResponse(response, importObject);
}

async function loadLocal(
	path: string,
	importObject: WebAssembly.Imports,
): Promise<WebAssembly.Instance> {
	const fs = await import(/* @vite-ignore */ NODE_FS_PROMISES_MODULE);
	const buffer = await fs.readFile(toLocalPath(path));
	const { instance } = await WebAssembly.instantiate(buffer, importObject);
	return instance;
}

async function loadFromResponse(
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

function shouldFetch(source: string): boolean {
	// In a browser environment, we can assume all string sources are URLs.
	if (typeof window !== "undefined") return true;
	try {
		const url = new URL(source);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

function toLocalPath(path: string): string | URL {
	try {
		const url = new URL(path);
		return url.protocol === "file:" ? url : path;
	} catch {
		return path;
	}
}
