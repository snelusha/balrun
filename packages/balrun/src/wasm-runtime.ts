import "./wasm_exec.js";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let ready: Promise<void> | null = null;

const filename = fileURLToPath(import.meta.url);
const dirnamePath = dirname(filename);

async function init(): Promise<void> {
	const go = new Go();
	const wasmPath = join(dirnamePath, "ballerina.wasm");
	const wasmBuffer = readFileSync(wasmPath);
	const { instance } = await WebAssembly.instantiate(
		wasmBuffer,
		go.importObject,
	);
	go.run(instance);
	await new Promise<void>((resolve) => setImmediate(resolve));
}

export function setup(): Promise<void> {
	ready ??= init().catch((error) => {
		ready = null;
		throw error;
	});
	return ready;
}
