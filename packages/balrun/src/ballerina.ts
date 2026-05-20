import type { FS } from "./fs/core";
import type {
	BallerinaCore,
	BallerinaRunOptions,
	BallerinaRunResult,
} from "./ballerina-core";
const DEFAULT_WASM_PATH = new URL("./ballerina.wasm", import.meta.url).href;

export interface BallerinaOptions extends BallerinaRunOptions {
	/** Filesystem exposed to the Ballerina runtime. Defaults to the Node adapter in Node.js. Required in browsers. */
	fs?: FS;
	/**
	 * A pre-constructed Ballerina core. When provided, `wasmUrl` is ignored and
	 * this core is used directly instead of loading the bundled WASM binary.
	 */
	core?: BallerinaCore;
	/** URL or local path of the Ballerina WASM binary to load. */
	wasmUrl?: string;
}

export class Ballerina {
	private _coreOption: BallerinaCore | undefined;
	private _wasmUrl: string | undefined;
	private _bridge: Promise<BallerinaCore> | null = null;

	private _fs: FS | undefined;
	private _defaults: BallerinaOptions;

	constructor(options: BallerinaOptions = {}) {
		this._fs = options.fs;
		this._coreOption = options.core;
		this._wasmUrl = options.wasmUrl;

		this._defaults = {
			colors: options.colors ?? true,
			stdout: options.stdout,
			stderr: options.stderr,
		};
	}

	private bridge(): Promise<BallerinaCore> {
		if (!this._bridge) {
			const promise = this._coreOption
				? Promise.resolve(this._coreOption)
				: import("./wasm-bridge").then(({ WasmBridge }) =>
						WasmBridge.load(this._wasmUrl ?? DEFAULT_WASM_PATH),
					);
			this._bridge = promise.catch((err) => {
				this._bridge = null;
				throw err;
			});
		}
		return this._bridge;
	}

	private async fs(): Promise<FS> {
		if (this._fs) return this._fs;
		if (typeof window !== "undefined") {
			throw new Error(
				"Ballerina requires an `fs` option in browser environments.",
			);
		}
		const { NodeFS } = await import("./fs/node");
		this._fs = new NodeFS();
		return this._fs;
	}

	async run(
		path: string,
		options?: BallerinaRunOptions,
	): Promise<BallerinaRunResult> {
		const bridge = await this.bridge();
		return bridge.run(await this.fs(), path, { ...this._defaults, ...options });
	}
}
