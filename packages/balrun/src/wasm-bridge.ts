import "./wasm_exec.js";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const filename = fileURLToPath(import.meta.url);
const dirnamePath = dirname(filename);

export class WasmBridge {
	private readonly go: Go;
	private readonly instance: WebAssembly.Instance;

	private constructor(go: Go, instance: WebAssembly.Instance) {
		this.go = go;
		this.instance = instance;
	}

	static async load(wasmPath?: string): Promise<WasmBridge> {
		const go = new Go();
		const resolvedPath = wasmPath ?? join(dirnamePath, "ballerina.wasm");
		const wasmBuffer = readFileSync(resolvedPath);
		const { instance } = await WebAssembly.instantiate(wasmBuffer, go.importObject);
		return new WasmBridge(go, instance);
	}

	async init(): Promise<void> {
		this.go.run(this.instance);
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}
