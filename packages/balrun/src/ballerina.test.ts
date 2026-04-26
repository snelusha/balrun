import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NodeFS } from "./node-fs";
import type { FS } from "./fs";

const { setupMock } = vi.hoisted(() => ({
	setupMock: vi.fn<() => Promise<void>>(),
}));

vi.mock("./wasm-runtime", () => ({
	setup: setupMock,
}));

import { Ballerina } from "./ballerina";

class MemFS implements FS {
	private files = new Map<string, string>();

	setFile(filePath: string, content: string): void {
		this.files.set(filePath, content);
	}

	async open(filePath: string) {
		const content = this.files.get(filePath);
		if (content === undefined) {
			return null;
		}
		return {
			content,
			size: content.length,
			modTime: Date.now(),
			isDir: false,
		};
	}

	async stat(filePath: string) {
		const content = this.files.get(filePath);
		if (content === undefined) {
			return null;
		}
		return {
			name: filePath.split("/").at(-1) ?? filePath,
			size: content.length,
			modTime: Date.now(),
			isDir: false,
		};
	}

	async readDir() {
		return [];
	}

	async writeFile(filePath: string, content: string) {
		this.files.set(filePath, content);
		return true;
	}

	async remove(filePath: string) {
		return this.files.delete(filePath);
	}

	async move(oldPath: string, newPath: string) {
		const content = this.files.get(oldPath);
		if (content === undefined) {
			return false;
		}
		this.files.delete(oldPath);
		this.files.set(newPath, content);
		return true;
	}

	async mkdirAll() {
		return true;
	}
}

describe("Ballerina", () => {
	let originalRun: typeof globalThis.run | undefined;

	beforeEach(() => {
		originalRun = globalThis.run;
		setupMock.mockReset();
		setupMock.mockResolvedValue(undefined);
	});

	afterEach(() => {
		(globalThis as { run?: typeof globalThis.run }).run = originalRun;
		vi.restoreAllMocks();
	});

	it("runs a ballerina file and writes expected stdout", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "balrun-ball-"));
		const filePath = path.join(tmpDir, "main.bal");
		await fs.writeFile(filePath, 'io:println("Hello from Balrun!");', "utf-8");

		try {
			const stdoutChunks: string[] = [];
			globalThis.run = vi.fn((proxy, targetPath, options) => {
				void proxy;
				const source = readFileSync(targetPath, "utf-8");
				const message = source.match(/"([^"]+)"/)?.[1] ?? "";
				options?.stdout?.write(`${message}\n`);
				return null;
			});

			const result = await new Ballerina({
				fs: new NodeFS(),
				stdout: { write: (chunk) => stdoutChunks.push(chunk) },
			}).run(filePath);

			expect(result).toBeNull();
			expect(stdoutChunks.join("")).toContain("Hello from Balrun!");
			expect(setupMock).toHaveBeenCalledTimes(1);
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("returns diagnostics with colors enabled by default", async () => {
		const inMemoryFs = new MemFS();
		inMemoryFs.setFile("/main.bal", "BROKEN_SOURCE");
		const stderrChunks: string[] = [];

		globalThis.run = vi.fn((proxy, targetPath, options) => {
			void proxy.open(targetPath);
			const diag = options?.colors
				? "\u001B[31merror: missing semicolon\u001B[0m\n"
				: "error: missing semicolon\n";
			options?.stderr?.write(diag);
			return { error: "compilation failed" };
		});

		const result = await new Ballerina({
			fs: inMemoryFs,
			stderr: { write: (chunk) => stderrChunks.push(chunk) },
		}).run("/main.bal");

		expect(result).toEqual({ error: "compilation failed" });
		expect(stderrChunks.join("")).toContain("\u001B[31merror: missing semicolon\u001B[0m");
	});

	it("disables colors when configured", async () => {
		const inMemoryFs = new MemFS();
		inMemoryFs.setFile("/main.bal", "BROKEN_SOURCE");
		const stderrChunks: string[] = [];

		globalThis.run = vi.fn((_proxy, _targetPath, options) => {
			const diag = options?.colors
				? "\u001B[31merror: missing semicolon\u001B[0m\n"
				: "error: missing semicolon\n";
			options?.stderr?.write(diag);
			return { error: "compilation failed" };
		});

		await new Ballerina({
			fs: inMemoryFs,
			colors: false,
			stderr: { write: (chunk) => stderrChunks.push(chunk) },
		}).run("/main.bal");

		expect(stderrChunks.join("")).toBe("error: missing semicolon\n");
	});

	it("lets run options override constructor defaults", async () => {
		const inMemoryFs = new MemFS();
		inMemoryFs.setFile("/main.bal", "ok");
		const constructorStdout: string[] = [];
		const runStdout: string[] = [];
		const runSpy = vi.fn((_proxy, _targetPath, options) => {
			options?.stdout?.write(options.colors ? "colored\n" : "plain\n");
			return null;
		});
		globalThis.run = runSpy;

		const ballerina = new Ballerina({
			fs: inMemoryFs,
			colors: false,
			stdout: { write: (chunk) => constructorStdout.push(chunk) },
		});

		const result = await ballerina.run("/main.bal", {
			colors: true,
			stdout: { write: (chunk) => runStdout.push(chunk) },
		});

		expect(result).toBeNull();
		expect(constructorStdout).toHaveLength(0);
		expect(runStdout).toEqual(["colored\n"]);
		expect(runSpy).toHaveBeenCalledWith(
			inMemoryFs,
			"/main.bal",
			expect.objectContaining({ colors: true }),
		);
	});

	it("passes through runtime errors and uses provided fs", async () => {
		const inMemoryFs = new MemFS();
		inMemoryFs.setFile("/main.bal", "panic");
		const runtimeResult = { error: "runtime panic" };
		const runSpy = vi.fn((proxy) => {
			expect(proxy).toBe(inMemoryFs);
			return runtimeResult;
		});
		globalThis.run = runSpy;

		const result = await new Ballerina({ fs: inMemoryFs }).run("/main.bal");

		expect(result).toBe(runtimeResult);
		expect(setupMock).toHaveBeenCalledTimes(1);
	});
});
