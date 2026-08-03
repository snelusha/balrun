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

		it("runs a Ballerina file and returns its exit code", async () => {
			const fs = new MemFS({
				"main.bal": await Bun.file(new URL("./fixtures/hello.bal", import.meta.url)).text(),
			});
			const stdout: string[] = [];
			const result = await bridge.run(fs, "main.bal", {
				stdout: { write: (chunk) => stdout.push(chunk) },
			});
			expect(result).toBe(0);
			expect(stdout.join("")).toBe("Hello, Ballerina!\n");
		});

		it("reads, writes, and appends files", async () => {
			const fs = new MemFS({
				"main.bal": await Bun.file(new URL("./fixtures/file-io.bal", import.meta.url)).text(),
			});
			const stdout: string[] = [];

			expect(
				await bridge.run(fs, "main.bal", {
					stdout: { write: (chunk) => stdout.push(chunk) },
				}),
			).toBe(0);
			expect(stdout.join("")).toBe("first second\n");
		});

		it("returns a non-zero exit code when loading fails", async () => {
			const stderr: string[] = [];
			const exitCode = await bridge.run(new MemFS({}), "missing.bal", {
				stderr: { write: (chunk) => stderr.push(chunk) },
			});

			expect(exitCode).toBe(1);
			expect(stderr.join("")).toBe("error: open missing.bal: file does not exist\n");
		});
	});
});
