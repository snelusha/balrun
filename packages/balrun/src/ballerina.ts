import { setup } from "./wasm-runtime";
import { NodeFS } from "./node-fs";

import type { FS } from "./fs";

export type StreamWriter = {
	write(chunk: string): void;
};

export interface BallerinaRunOptions {
	colors?: boolean;
	stdout?: StreamWriter;
	stderr?: StreamWriter;
}

export interface BallerinaOptions extends BallerinaRunOptions {
	fs?: FS;
}

export class Ballerina {
	private readonly fs: FS;
	private readonly defaults: BallerinaRunOptions;

	constructor(options?: BallerinaOptions) {
		this.fs = options?.fs ?? new NodeFS();
		this.defaults = {
			colors: options?.colors ?? true,
			stdout: options?.stdout,
			stderr: options?.stderr,
		};
	}

	async run(
		path: string,
		options?: BallerinaRunOptions,
	): Promise<{ error?: string } | null> {
		await setup();
		return globalThis.run(this.fs, path, { ...this.defaults, ...options });
	}
}
