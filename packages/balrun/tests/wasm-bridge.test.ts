import { beforeAll, describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

import { WasmBridge } from "../src/wasm-bridge";
import { MemFS } from "./memfs";

const WASM_PATH = new URL("../dist/ballerina.wasm", import.meta.url).href;

describe("WasmBridge", () => {
	let bridge: WasmBridge;

	beforeAll(async () => {
		bridge = await WasmBridge.load(WASM_PATH);
	});

	describe("load", () => {
		it("loads the WASM from a file path", async () => {
			const bridge = await WasmBridge.load(WASM_PATH);
			expect(bridge).toBeInstanceOf(WasmBridge);
		});

		it("loads the WASM from a Response", async () => {
			const response = await fetch(WASM_PATH);
			const bridge = await WasmBridge.load(response);
			expect(bridge).toBeInstanceOf(WasmBridge);
		});

		it("loads the WASM from a Promise<Response>", async () => {
			const bridge = await WasmBridge.load(fetch(WASM_PATH));
			expect(bridge).toBeInstanceOf(WasmBridge);
		});

		it("loads the WASM from a plain local path", async () => {
			const bridge = await WasmBridge.load(fileURLToPath(WASM_PATH));
			expect(bridge).toBeInstanceOf(WasmBridge);
		});

		it("falls back to arrayBuffer when instantiateStreaming fails", async () => {
			const originalInstantiateStreaming = WebAssembly.instantiateStreaming;
			WebAssembly.instantiateStreaming = (() => {
				throw new Error("streaming unavailable");
			}) as typeof WebAssembly.instantiateStreaming;

			try {
				const bridge = await WasmBridge.load(fetch(WASM_PATH));
				expect(bridge).toBeInstanceOf(WasmBridge);
			} finally {
				WebAssembly.instantiateStreaming = originalInstantiateStreaming;
			}
		});

		it("throws on non-OK Response", async () => {
			expect(
				WasmBridge.load(new Response("missing", { status: 404, statusText: "Not Found" })),
			).rejects.toThrow("[balrun]: failed to load WASM: 404 Not Found");
		});

		it("throws on invalid URL", async () => {
			expect(WasmBridge.load("https://localhost:6969/somewhere.wasm")).rejects.toThrow();
		});

		it("throws when source is empty", async () => {
			expect(WasmBridge.load("")).rejects.toThrow("[balrun]: WASM source must not be empty.");
		});

		it("throws on invalid local path", async () => {
			expect(WasmBridge.load("/tmp/balrun-missing.wasm")).rejects.toThrow();
		});
	});

	describe("run", () => {
		it("throws when run path is empty", async () => {
			expect(bridge.run(new MemFS({}), "")).rejects.toThrow(
				"[balrun]: run path must not be empty.",
			);
		});

		it("returns false when stopping without an active run", async () => {
			expect(await bridge.stop()).toBe(false);
		});

		it("gracefully stops an active listener", async () => {
			const fs = new MemFS({
				"main.bal": await Bun.file(new URL("./fixtures/listener.bal", import.meta.url)).text(),
			});
			const stdout: string[] = [];
			const running = bridge.run(fs, "main.bal", {
				stdout: { write: (chunk) => stdout.push(chunk) },
			});

			await waitFor(() => stdout.join("").includes("Listener started."));
			expect(await bridge.stop("graceful")).toBe(true);
			await running;
			expect(stdout.join("")).toContain("Graceful stop initiated.");
		});

		it("immediately stops an active listener", async () => {
			const fs = new MemFS({
				"main.bal": await Bun.file(new URL("./fixtures/listener.bal", import.meta.url)).text(),
			});
			const stdout: string[] = [];
			const running = bridge.run(fs, "main.bal", {
				stdout: { write: (chunk) => stdout.push(chunk) },
			});

			await waitFor(() => stdout.join("").includes("Listener started."));
			expect(await bridge.stop("immediate")).toBe(true);
			await running;
			expect(stdout.join("")).toContain("Immediate stop initiated.");
		});

		it("runs a Ballerina file and returns the result", async () => {
			const fs = new MemFS({
				"main.bal": await Bun.file(new URL("./fixtures/hello.bal", import.meta.url)).text(),
			});
			const stdout: string[] = [];
			const result = await bridge.run(fs, "main.bal", {
				stdout: { write: (chunk) => stdout.push(chunk) },
			});
			expect(result).toBeNull();
			expect(stdout.join("")).toBe("Hello, Ballerina!\n");
		});
	});
});

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let i = 0; i < 100; i++) {
		if (predicate()) return;
		await Bun.sleep(10);
	}
	throw new Error("timed out waiting for listener to start");
}
