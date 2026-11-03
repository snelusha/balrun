import { WasmBridge } from "../../src/wasm-bridge";
import { MemFS } from "../memfs";

const bridge = WasmBridge.load("/ballerina.wasm");

async function runCase(files: Record<string, string>, entry: string) {
	let stdout = "";
	let stderr = "";
	const exitCode = await (
		await bridge
	).run(new MemFS(files), entry, {
		colors: false,
		stdout: {
			write: (chunk) => {
				stdout += chunk;
			},
		},
		stderr: {
			write: (chunk) => {
				stderr += chunk;
			},
		},
	});
	return { stdout, stderr, exitcode: String(exitCode) };
}

Reflect.set(globalThis, "runCase", runCase);
