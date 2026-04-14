import "./wasm_exec.js";
import wasmBase64 from "./ballerina.wasm";

let ready: Promise<void> | null = null;

async function init(): Promise<void> {
	const go = new Go();

	const base64 = wasmBase64.split(",")[1];
	const binary = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

	const { instance } = await WebAssembly.instantiate(binary, go.importObject);
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
