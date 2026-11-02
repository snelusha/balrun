import { beforeAll, describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

import { WasmBridge } from "../src/wasm-bridge";
import { MemFS } from "./memfs";

import type { WasmExports } from "../src/wasm-bridge";

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

	describe("version", () => {
		it("reports the embedded interpreter version and revision", async () => {
			expect(await bridge.version()).toMatchObject({
				version: expect.stringMatching(/^v\d+\.\d+\.\d+$/),
				revision: expect.stringMatching(/^[0-9a-f]{40}$/),
			});
		});
	});

	describe("run", () => {
		it("throws when run path is empty", async () => {
			expect(bridge.run(new MemFS({}), "")).rejects.toThrow(
				"[balrun]: run path must not be empty.",
			);
		});

		it("rejects absolute run paths for filesystems that do not support them", async () => {
			expect(bridge.run(new MemFS({}), "/main.bal")).rejects.toThrow(
				"[balrun]: filesystem does not support absolute run paths.",
			);
		});

		it("rejects concurrent runs", async () => {
			const isolatedBridge = new WasmBridge();
			let resolveRun: (result: number) => void = () => {};
			const pendingRun = new Promise<number>((resolve) => {
				resolveRun = resolve;
			});
			(isolatedBridge as unknown as { exports: Pick<WasmExports, "run"> }).exports = {
				run: () => pendingRun,
			};

			const activeRun = isolatedBridge.run(new MemFS({}), "main.bal");
			expect(isolatedBridge.run(new MemFS({}), "main.bal")).rejects.toThrow(
				"[balrun]: a run is already active.",
			);
			resolveRun(0);
			expect(await activeRun).toBe(0);
			expect(await isolatedBridge.run(new MemFS({}), "main.bal")).toBe(0);
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
