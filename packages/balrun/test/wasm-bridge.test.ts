import { describe, expect, test } from "bun:test";

import { WasmBridge } from "../src/wasm-bridge";
import { MemFS } from "./helpers";

const wasmFile = Bun.file(
	new URL("../../ballerina-wasm/dist/ballerina.wasm", import.meta.url),
);

function collect() {
	let value = "";
	return {
		writer: { write: (chunk: string) => (value += chunk) },
		read: () => value,
	};
}

async function expectHelloWorld(bridge: WasmBridge) {
	const stdout = collect();
	const stderr = collect();
	const fs = new MemFS({
		"main.bal":
			'import ballerina/io;\npublic function main() { io:println("Hello, World!"); }',
	});

	const result = await bridge.run(fs, "main.bal", {
		colors: false,
		stdout: stdout.writer,
		stderr: stderr.writer,
	});

	expect(result).toBeNull();
	expect(stdout.read()).toBe("Hello, World!\n");
	expect(stderr.read()).toBe("");
}

describe("WasmBridge.load", () => {
	test("loads from a Response, falling back when streaming cannot be used", async () => {
		const response = new Response(await wasmFile.arrayBuffer(), {
			headers: { "content-type": "text/plain" },
		});

		const bridge = await WasmBridge.load(response);

		await expectHelloWorld(bridge);
	});

	test("loads from an HTTP URL", async () => {
		const server = Bun.serve({
			port: 0,
			fetch() {
				return new Response(wasmFile, {
					headers: { "content-type": "application/wasm" },
				});
			},
		});

		try {
			const bridge = await WasmBridge.load(server.url.href);
			await expectHelloWorld(bridge);
		} finally {
			server.stop(true);
		}
	});

	test("rejects non-OK responses", async () => {
		await expect(
			WasmBridge.load(
				new Response("missing", { status: 404, statusText: "Not Found" }),
			),
		).rejects.toThrow("Failed to load WASM: 404 Not Found");
	});
});
