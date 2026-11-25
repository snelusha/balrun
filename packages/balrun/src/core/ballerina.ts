import { WasmBridge } from "./bridge";
import { BALRUN_VERSION } from "./version";

import type {
	BallerinaCore,
	BallerinaRunOptions,
	BallerinaRunResult,
	BalrunVersion,
	BallerinaStopMode,
} from "./ballerina-core";
import type { Fs } from "./fs";
import type { HTTPDispatchRequest, HTTPListenerResponse } from "./http-listener";
import type { Platform } from "./platform";

export interface BallerinaOptions extends BallerinaRunOptions {
	/** Filesystem exposed to the Ballerina runtime. Defaults to the Node adapter in Node.js. Required in browsers. */
	fs?: Fs;
	/**
	 * A pre-constructed Ballerina core. When provided, `wasmSource` is ignored and
	 * this core is used directly instead of loading the bundled WASM binary.
	 */
	core?: BallerinaCore;
	/** URL or local path of the Ballerina WASM binary to load. */
	wasmSource?: string;
}

export class Ballerina {
	private _platform: Platform;
	private _coreOption: BallerinaCore | undefined;
	private _wasmSource: string | undefined;
	private _bridge: BallerinaCore | null = null;
	private _bridgePromise: Promise<BallerinaCore> | null = null;

	private _fs: Fs | undefined;
	private _defaults: BallerinaOptions;

	constructor(platform: Platform, options: BallerinaOptions = {}) {
		this._platform = platform;
		this._fs = options.fs;
		this._coreOption = options.core;
		this._wasmSource = options.wasmSource;

		this._defaults = {
			colors: options.colors ?? true,
			stdout: options.stdout,
			stderr: options.stderr,
			env: options.env,
		};
	}

	async init(): Promise<this> {
		await this.bridge();
		await this.fs();
		return this;
	}

	private async bridge(): Promise<BallerinaCore> {
		if (this._bridge) return this._bridge;

		this._bridgePromise ??= (async () => {
			try {
				const bridge =
					this._coreOption ??
					(await new WasmBridge(this._platform).start(this._wasmSource ?? this._platform.wasm));

				this._bridge = bridge;
				return bridge;
			} catch (err) {
				this._bridgePromise = null;
				throw new Error(
					`[balrun]: failed to initialize the WASM bridge: ${err instanceof Error ? err.message : err}`,
				);
			}
		})();

		return this._bridgePromise;
	}

	private async fs(): Promise<Fs> {
		if (this._fs) return this._fs;

		const fs = this._platform.defaultFS?.();
		if (!fs)
			throw new Error("[balrun]: `fs` option is required outside Node-compatible environments.");
		this._fs = fs;
		return fs;
	}

	async run(path: string, options?: BallerinaRunOptions): Promise<BallerinaRunResult> {
		if (path === "") throw new Error("[balrun]: run path must not be empty.");
		const bridge = await this.bridge();
		return bridge.run(await this.fs(), path, {
			...this._defaults,
			...options,
		});
	}

	async version(): Promise<BalrunVersion> {
		return {
			balrun: BALRUN_VERSION,
			interpreter: await (await this.bridge()).version(),
		};
	}

	async stop(mode: BallerinaStopMode = "graceful"): Promise<boolean> {
		return (await this.bridge()).stop(mode);
	}

	async dispatchHttpRequest(request: HTTPDispatchRequest): Promise<HTTPListenerResponse> {
		return (await this.bridge()).dispatchHttpRequest(request);
	}
}
