import { describe, expect, test } from "bun:test";

import { Ballerina } from "../src/ballerina";
import { MemFS } from "./helpers";

const wasmUrl = new URL(
	"../../ballerina-wasm/dist/ballerina.wasm",
	import.meta.url,
).href;

function collect() {
	let value = "";
	return {
		writer: { write: (chunk: string) => (value += chunk) },
		read: () => value,
	};
}

describe("Ballerina WASM integration", () => {
	test("redirects program stdout", async () => {
		const stdout = collect();
		const stderr = collect();
		const fs = new MemFS({
			"main.bal":
				'import ballerina/io;\npublic function main() { io:println("Hello, World!"); }',
		});

		const result = await new Ballerina({ fs, wasmUrl }).run("main.bal", {
			colors: false,
			stdout: stdout.writer,
			stderr: stderr.writer,
		});

		expect(result).toBeNull();
		expect(stdout.read()).toBe("Hello, World!\n");
		expect(stderr.read()).toBe("");
	});

	test("prints diagnostics without colors", async () => {
		const stdout = collect();
		const stderr = collect();
		const fs = new MemFS({
			"main.bal": 'public function main() { int a = "b"; }',
		});

		const result = await new Ballerina({ fs, wasmUrl }).run("main.bal", {
			colors: false,
			stdout: stdout.writer,
			stderr: stderr.writer,
		});

		expect(result).toBeNull();
		expect(stdout.read()).toBe("");
		expect(stderr.read()).toContain(
			'error[SEMANTIC_ERROR]: incompatible type: expected int, got "b"',
		);
		expect(stderr.read()).toContain("--> main.bal:1:34");
		expect(stderr.read()).not.toContain("\u001B[");
	});

	test("prints diagnostics with colors", async () => {
		const stdout = collect();
		const stderr = collect();
		const fs = new MemFS({
			"main.bal": 'public function main() { int a = "b"; }',
		});

		const result = await new Ballerina({ fs, wasmUrl }).run("main.bal", {
			colors: true,
			stdout: stdout.writer,
			stderr: stderr.writer,
		});

		expect(result).toBeNull();
		expect(stdout.read()).toBe("");
		expect(stderr.read()).toContain("\u001B[31merror[SEMANTIC_ERROR]");
		expect(stderr.read()).toContain('incompatible type: expected int, got "b"');
		expect(stderr.read()).toContain("main.bal:1:34");
	});
});
