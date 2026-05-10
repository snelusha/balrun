import { NodeFS } from "./node-fs";
import { WasmBridge } from "./wasm-bridge";

import type { FS } from "./fs";
import type { BallerinaCore } from "./ballerina-core";
import type { BallerinaRunOptions, BallerinaRunResult } from "./types";

const DEFAULT_WASM_PATH = new URL("./ballerina.wasm", import.meta.url).href;

export interface BallerinaOptions extends BallerinaRunOptions {
	core?: BallerinaCore;
	fs?: FS;
}

export class Ballerina {
	private _bridge: Promise<BallerinaCore> | null = null;

	private readonly fs: FS;
	private readonly _coreOptions: BallerinaCore | undefined;
	private readonly defaults: BallerinaRunOptions;

	constructor(options: BallerinaOptions = {}) {
		this.fs = options?.fs ?? new NodeFS();
		this._coreOptions = options.core;

		this.defaults = {
			colors: options?.colors ?? true,
			stdout: options?.stdout,
			stderr: options?.stderr,
		};
	}

	private bridge(): Promise<BallerinaCore> {
		this._bridge ??= this._coreOptions
			? Promise.resolve(this._coreOptions)
			: WasmBridge.load(DEFAULT_WASM_PATH);
		return this._bridge;
	}

	async run(
		path: string,
		options?: BallerinaRunOptions,
	): Promise<BallerinaRunResult> {
		const bridge = await this.bridge();
		return bridge.run(this.fs, path, {
			...this.defaults,
			...options,
		});
	}
}
