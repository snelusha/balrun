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

	describe("run", () => {
		it("throws when run path is empty", async () => {
			expect(bridge.run(new MemFS({}), "")).rejects.toThrow(
				"[balrun]: run path must not be empty.",
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

		it("supports OS operations and subprocesses", async () => {
			const fs = new MemFS({
				"main.bal": await Bun.file(new URL("./fixtures/os.bal", import.meta.url)).text(),
			});
			const stdout: string[] = [];

			expect(
				await bridge.run(fs, "main.bal", {
					stdout: { write: (chunk) => stdout.push(chunk) },
				}),
			).toBe(0);
			expect(stdout.join("")).toBe("present\npresent\ntrue\ntrue\ntrue\n0\nhello\n\ntrue\n");
		});

		it("returns a non-zero exit code when loading fails", async () => {
			const stderr: string[] = [];
			const exitCode = await bridge.run(new MemFS({}), "missing.bal", {
				stderr: { write: (chunk) => stderr.push(chunk) },
			});

			expect(exitCode).toBe(1);
			expect(stderr.join("")).toBe("error: open missing.bal: file does not exist\n");
		});

		it("serves HTTP listeners and stops them", async () => {
			const source = await Bun.file(
				new URL("./fixtures/http-listener.bal", import.meta.url),
			).text();
			let resolveListener: (listener: { host: string; port: number }) => void;
			const listenerReady = new Promise<{ host: string; port: number }>((resolve) => {
				resolveListener = resolve;
			});
			const run = bridge.run(new MemFS({ "main.bal": source }), "main.bal", {
				onListenerReady: (listener) => resolveListener(listener),
			});
			const listener = await listenerReady;
			const origin = `http://${listener.host}:${listener.port}`;
			const response = await fetch(`${origin}/ping`);
			expect(response.status).toBe(200);
			expect(await response.text()).toBe("pong");
			expect(response.headers.get("x-reply")).toBe("one, two");
			const dispatched = await bridge.dispatchHttpRequest({
				host: "localhost",
				port: listener.port,
				path: "/ping",
			});
			expect(new TextDecoder().decode(dispatched.body)).toBe("pong");

			const inspected = await fetch(`${origin}/inspect?name=balrun`, {
				headers: { "X-Test": "request-header" },
			});
			expect(await inspected.text()).toBe("balrun|request-header");

			for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
				const echoed = await fetch(`${origin}/echo`, { method, body: `${method} body` });
				expect(echoed.status).toBe(200);
				expect(await echoed.text()).toBe(`${method} body`);
			}
			const tooLarge = await fetch(`${origin}/echo`, {
				method: "POST",
				body: "x".repeat(1024 * 1024 + 1),
			});
			expect(tooLarge.status).toBe(413);
			const head = await fetch(`${origin}/echo`, { method: "HEAD" });
			expect(head.status).toBe(200);
			expect(await head.text()).toBe("");
			const options = await fetch(`${origin}/echo`, { method: "OPTIONS" });
			expect(options.status).toBe(200);
			expect(await options.text()).toBe("options");

			const missing = await fetch(`${origin}/`);
			expect(missing.status).toBe(404);
			expect((await missing.json()).message).toBe("no matching resource found for path");
			expect(bridge.stop("graceful")).toBe(true);
			expect(await run).toBe(130);
		});
	});
});
