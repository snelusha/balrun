import { NodeFS } from "./node-fs";
import { WasmBridge } from "./wasm-bridge";

import type { FS } from "./fs";
import type { BallerinaCore } from "./ballerina-core";
import type { BallerinaRunOptions, BallerinaRunResult } from "./types";

export interface BallerinaOptions extends BallerinaRunOptions {
	core?: BallerinaCore;
	fs?: FS;
}

export class Ballerina {
	bridge: BallerinaCore | null = null;

	private readonly fs: FS;
	private _coreOptions: BallerinaCore | undefined;

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

	async init(): Promise<this> {
		if (this._coreOptions) {
			this.bridge = this._coreOptions;
		} else {
			this.bridge = await WasmBridge.load(
				new URL("./ballerina.wasm", import.meta.url).href,
			);
		}
		return this;
	}

	async run(
		path: string,
		options?: BallerinaRunOptions,
	): Promise<BallerinaRunResult> {
		await this.init();

		if (!this.bridge) {
			throw new Error(
				"Ballerina bridge is not initialized. Call init() before running.",
			);
		}
		return this.bridge.run(this.fs, path, {
			...this.defaults,
			...options,
		});
	}
}
