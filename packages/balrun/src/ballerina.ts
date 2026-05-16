import type { FS } from "./fs";
import type {
	BallerinaCore,
	BallerinaRunOptions,
	BallerinaRunResult,
} from "./ballerina-core";
import { NodeFS } from "./node-fs";

const DEFAULT_WASM_PATH = new URL("./ballerina.wasm", import.meta.url).href;

export interface BallerinaOptions extends BallerinaRunOptions {
	/** Filesystem exposed to the Ballerina runtime. Defaults to a new NodeFS instance. */
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

	private _fs: FS;
	private _defaults: BallerinaOptions;

	constructor(options: BallerinaOptions = {}) {
		this._fs = options.fs ?? new NodeFS();
		this._coreOption = options.core;
		this._wasmUrl = options.wasmUrl;

		this._defaults = {
			colors: options.colors ?? true,
			stdout: options.stdout,
			stderr: options.stderr,
		};
	}

	private bridge(): Promise<BallerinaCore> {
		this._bridge ??= this._coreOption
			? Promise.resolve(this._coreOption)
			: import("./wasm-bridge").then(({ WasmBridge }) =>
					WasmBridge.load(this._wasmUrl ?? DEFAULT_WASM_PATH),
				);
		return this._bridge;
	}

	async run(
		path: string,
		options?: BallerinaRunOptions,
	): Promise<BallerinaRunResult> {
		const bridge = await this.bridge();
		return bridge.run(this._fs, path, { ...this._defaults, ...options });
	}
}
