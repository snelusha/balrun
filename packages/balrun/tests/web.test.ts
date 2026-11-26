import { describe, expect, it } from "bun:test";

import { Ballerina, WasmBridge } from "../src/web";
import { MemFS } from "../src/core/memfs";

const WASM_URL = new URL("../dist/ballerina.wasm", import.meta.url).href;

describe("web entry", () => {
	it("requires an fs", async () => {
		const ballerina = new Ballerina({ core: await WasmBridge.load(WASM_URL) });

		expect(ballerina.run("main.bal")).rejects.toThrow(
			"[balrun]: `fs` option is required outside Node-compatible environments.",
		);
	});

	it("runs a Ballerina file with a fetched WASM", async () => {
		const fs = new MemFS({
			"main.bal": await Bun.file(new URL("./fixtures/hello.bal", import.meta.url)).text(),
		});
		const stdout: string[] = [];
		const ballerina = new Ballerina({
			fs,
			wasmSource: WASM_URL,
			stdout: { write: (chunk) => stdout.push(chunk) },
		});

		expect(await ballerina.run("main.bal")).toBe(0);
		expect(stdout.join("")).toBe("Hello, Ballerina!\n");
	});
});
