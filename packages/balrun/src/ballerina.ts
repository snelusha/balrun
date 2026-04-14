import { setup } from "./wasm-runtime";

import { NodeFS } from "./node-fs";

import type { FS } from "./fs";

export interface BallerinaOptions {
	fs?: FS;
	colors?: boolean;
}

export class Ballerina {
	private readonly fs: FS;
	private readonly colors: boolean;

	constructor(options?: BallerinaOptions) {
		this.fs = options?.fs ?? new NodeFS();
		this.colors = options?.colors ?? true;
	}

	async run(path: string): Promise<{ error?: string } | null> {
		await setup();
		return globalThis.run(this.fs, path, {
			colors: this.colors,
		});
	}
}
