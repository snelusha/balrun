import "./wasm_exec";

import type { FS } from "./fs";
import type { BallerinaCore } from "./ballerina-core";
import type { BallerinaRunOptions, BallerinaRunResult } from "./types";

export class WasmBridge implements BallerinaCore {
	static async load(
		source: string | Response | PromiseLike<Response>,
	): Promise<WasmBridge> {
		try {
			const go = new Go();
			const { instance } = await WebAssembly.instantiateStreaming(
				typeof source === "string" ? fetch(source) : source,
				go.importObject,
			);
			go.run(instance);
			await new Promise<void>((resolve) => setImmediate(resolve));
			return new WasmBridge();
		} catch (e) {
			console.error(e);
			throw new Error("Failed to load Ballerina WebAssembly module.");
		}
	}

	run(
		proxy: FS,
		path: string,
		options?: BallerinaRunOptions,
	): Promise<BallerinaRunResult> {
		return globalThis.run(proxy, path, options);
	}
}
