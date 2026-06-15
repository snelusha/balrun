import { NodeFS } from "./fs/node";

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
	 * A pre-constructed Ballerina core. When provided, `wasmSource` is ignored and
	 * this core is used directly instead of loading the bundled WASM binary.
	 */
	core?: BallerinaCore;
	/** URL or local path of the Ballerina WASM binary to load. */
	wasmSource?: string;
}

export class Ballerina {
	private _coreOption: BallerinaCore | undefined;
	private _wasmSource: string | undefined;
	private _bridge: BallerinaCore | null = null;
	private _bridgePromise: Promise<BallerinaCore> | null = null;

	private _fs: FS | undefined;
	private _defaults: BallerinaOptions;

	constructor(options: BallerinaOptions = {}) {
		this._fs = options.fs;
		this._coreOption = options.core;
		this._wasmSource = options.wasmSource;

		this._defaults = {
			colors: options.colors ?? true,
			stdout: options.stdout,
			stderr: options.stderr,
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
				const bridge = this._coreOption
					? this._coreOption
					: await import("./wasm-bridge").then(({ WasmBridge }) =>
							WasmBridge.load(this._wasmSource ?? DEFAULT_WASM_PATH),
						);

				this._bridge = bridge;
				return bridge;
			} catch (err) {
				this._bridgePromise = null;
				throw new Error(
					`Ballerina: Failed to initialize the WASM bridge: ${err instanceof Error ? err.message : err}`,
				);
			}
		})();

		return this._bridgePromise;
	}

	private async fs(): Promise<FS> {
		if (this._fs) return this._fs;
		if (!supportsNodeFS())
			throw new Error(
				"Ballerina requires an `fs` option outside Node-compatible environments.",
			);

		const fs = new NodeFS();
		this._fs = fs;
		return fs;
	}

	async run(
		path: string,
		options?: BallerinaRunOptions,
	): Promise<BallerinaRunResult> {
		const bridge = await this.bridge();
		return bridge.run(await this.fs(), path, {
			...this._defaults,
			...options,
		});
	}
}

function supportsNodeFS(): boolean {
	return typeof process !== "undefined" && !!process.versions?.node;
}
