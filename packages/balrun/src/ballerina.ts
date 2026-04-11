import { setup } from "./wasm-runtime";

import { NodeFS } from "./node-fs";

import type { FS } from "./fs";

export interface BallerinaOptions {
	fs?: FS;
}

export class Ballerina {
	private readonly fs: FS;

	constructor(options?: BallerinaOptions) {
		this.fs = options?.fs ?? new NodeFS();
	}

	async run(path: string): Promise<{ error?: string } | null> {
		await setup();
		return globalThis.run(this.fs, path);
	}
}
