import { setup } from "./wasm-runtime";

import { NodeFS } from "./node-fs";

import type { Writable } from "node:stream";

import type { FS } from "./fs";

export interface BallerinaOptions {
	fs?: FS;
	colors?: boolean;
}

export interface BallerinaRunOptions {
	stdout?: Writable;
	stderr?: Writable;
}

function createSink(stream: Writable): { write(s: string): void } {
	return {
		write(s: string) {
			stream.write(s, "utf8");
		},
	};
}

export class Ballerina {
	private readonly fs: FS;
	private readonly colors: boolean;

	constructor(options?: BallerinaOptions) {
		this.fs = options?.fs ?? new NodeFS();
		this.colors = options?.colors ?? true;
	}

	async run(
		path: string,
		runOptions?: BallerinaRunOptions,
	): Promise<{ error?: string } | null> {
		await setup();
		return globalThis.run(this.fs, path, {
			colors: this.colors,
			stdout: createSink(runOptions?.stdout ?? process.stdout),
			stderr: createSink(runOptions?.stderr ?? process.stderr),
		});
	}
}
