import { beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { FsError, NodeFS, WasmBridge } from "../src/node";
import { MemFS } from "../src/core/memfs";

import type { WasmExports } from "../src/core/bridge";
import type { Fs, FsFile, FsOpenFlags } from "../src/node";

const WASM_PATH = new URL("../dist/ballerina.wasm", import.meta.url).href;

const FILE_OPS_OUTPUT = [
	"true",
	"true",
	"content",
	"true",
	"true",
	"content",
	"a.txt false true true",
	"nested true true true",
	"true",
	"content",
	"temp",
	"true",
	"true",
	"false",
	"true",
	"true",
];
const unsupportedCopy = (path: string) =>
	`An error occurred when copying the file/s: ${path}: unsupported operation`;

const lines = (chunks: string[]) => chunks.join("").trimEnd().split("\n");

describe("WasmBridge", () => {
	let bridge: WasmBridge;

	beforeAll(async () => {
		bridge = await WasmBridge.load(WASM_PATH);
	});

	async function fixture<T extends Fs = MemFS>(
		name: string,
		createFs: (files: Record<string, string>) => T = (files) => new MemFS(files) as Fs as T,
	) {
		const fs = createFs({
			"main.bal": await Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).text(),
		});
		const stdout: string[] = [];
		const run = () =>
			bridge.run(fs, "main.bal", { stdout: { write: (chunk) => stdout.push(chunk) } });
		return { fs, stdout, run };
	}

	/** Runs a program that leaves a file open for writing. */
	async function leaveOpen(close: () => void | Promise<void>) {
		const events: string[] = [];
		const stderr: string[] = [];
		const { fs } = await fixture("leave-open.bal", (files): Fs => {
			const fs = new MemFS(files);
			return {
				stat: (path) => fs.stat(path),
				readdir: (path) => fs.readdir(path),
				open: (path, flags) => {
					const file = fs.open(path, flags);
					if (!flags.write) return file;
					return {
						read: file.read.bind(file),
						write: file.write?.bind(file),
						close: async () => {
							events.push("closing");
							await close();
							events.push("closed");
						},
					};
				},
			};
		});
		const run = () =>
			bridge.run(fs, "main.bal", { stderr: { write: (chunk) => stderr.push(chunk) } });
		return { events, stderr, run };
	}

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

		it("keeps binary content unchanged", async () => {
			const { fs, stdout, run } = await fixture("binary-io.bal");

			expect(await run()).toBe(0);
			expect(stdout.join("")).toBe("[255,254,0,128]\n");
			expect(Array.from(fs.readFile("b.bin"))).toEqual([0xff, 0xfe, 0x00, 0x80]);
		});

		it("streams files and closes the ones left open", async () => {
			let open = 0;
			class CountingFS extends MemFS {
				override open(path: string, flags: FsOpenFlags): FsFile {
					const file = super.open(path, flags);
					open++;
					return {
						read: async (offset, length) => file.read(offset, length),
						write: file.write && (async (offset, data) => file.write!(offset, data)),
						close: () => {
							open--;
						},
					};
				}
			}
			const { stdout, run } = await fixture("stream-io.bal", (files) => new CountingFS(files));
			open = 0;

			expect(await run()).toBe(0);
			expect(stdout.join("")).toBe("first\nsecond\nthird\n8\n8\n3\n");
			await Bun.sleep(0);
			expect(open).toBe(0);
		});

		it("resolves once files left open for writing are closed", async () => {
			const { events, run } = await leaveOpen(async () => {
				await Bun.sleep(20);
			});
			expect(await run()).toBe(0);
			expect(events).toEqual(["closing", "closed"]);
		});

		it("reports files that fail to close", async () => {
			const { stderr, run } = await leaveOpen(() => {
				throw new FsError("ENOSPC");
			});
			expect(await run()).toBe(0);
			expect(stderr.join("")).toContain("error: close out.txt: ");
		});

		it("closes files whose open finishes after the run ends", async () => {
			const opening = Promise.withResolvers<void>();
			const finishOpen = Promise.withResolvers<void>();
			const closed = Promise.withResolvers<void>();
			const { fs } = await fixture("late-open.bal", (files): Fs => {
				const fs = new MemFS({ ...files, "late.bin": "" });
				return {
					stat: (path) => fs.stat(path),
					readdir: (path) => fs.readdir(path),
					open: async (path, flags) => {
						const file = fs.open(path, flags);
						if (path !== "late.bin") return file;
						opening.resolve();
						await finishOpen.promise;
						return {
							read: () => {
								throw new FsError("EIO");
							},
							close: () => closed.resolve(),
						};
					},
				};
			});

			const listening = Promise.withResolvers<void>();
			const result = bridge.run(fs, "main.bal", { onListenerReady: () => listening.resolve() });
			await listening.promise;
			const request = { host: "localhost", port: 6969, path: "/read" };
			void bridge.dispatchHttpRequest(request).catch(() => {});
			await opening.promise;
			expect(bridge.stop("immediate")).toBe(true);
			await result;
			await Bun.sleep(0);
			finishOpen.resolve();
			await closed.promise;
		});

		it("continues short writes", async () => {
			const { stdout, run } = await fixture("binary-io.bal", (files): Fs => {
				const fs = new MemFS(files);
				return {
					stat: (path) => fs.stat(path),
					readdir: (path) => fs.readdir(path),
					open: (path, flags) => {
						const file = fs.open(path, flags);
						return {
							read: file.read.bind(file),
							write: file.write && ((offset, data) => file.write!(offset, data.subarray(0, 1))),
						};
					},
				};
			});

			expect(await run()).toBe(0);
			expect(stdout.join("")).toBe("[255,254,0,128]\n");
		});

		it("reports thenables that throw", async () => {
			class ThrowingFS extends MemFS {
				override readFile(path: string): Uint8Array {
					if (path !== "denied.txt") return super.readFile(path);
					return {
						// oxlint-disable-next-line unicorn/no-thenable
						then() {
							throw new FsError("EACCES");
						},
					} as unknown as Uint8Array;
				}
			}
			const { stdout, run } = await fixture("fs-errors.bal", (files) => new ThrowingFS(files));

			expect(await run()).toBe(0);
			expect(lines(stdout)).toContain(
				"error while reading file 'denied.txt': read denied.txt: Permission denied",
			);
		});

		it("preserves error codes", async () => {
			class FailingFS extends MemFS {
				override readFile(path: string): Uint8Array {
					if (path === "denied.txt") throw new FsError("EACCES");
					if (path === "broken.txt") throw new Error("disk on fire");
					if (path === "thrown.txt") throw undefined;
					return super.readFile(path);
				}

				override writeFile(path: string, data: Uint8Array | string): void {
					if (path === "dir/new.txt") throw new FsError("ENOSPC");
					super.writeFile(path, data);
				}
			}
			const { stdout, run } = await fixture("fs-errors.bal", (files) => {
				const fs = new FailingFS(files);
				fs.mkdir("dir", { recursive: true });
				return fs;
			});

			expect(await run()).toBe(0);
			expect(lines(stdout)).toEqual([
				"error while reading file 'missing.txt': read missing.txt: No such file or directory",
				"error while reading file 'dir': read dir: Is a directory",
				"error while reading file 'denied.txt': read denied.txt: Permission denied",
				"error while reading file 'broken.txt': read broken.txt: disk on fire",
				"error while reading file 'thrown.txt': read thrown.txt: I/O error",
				"error while writing to file 'dir/new.txt': write dir/new.txt: No space left on device",
			]);
		});

		it("treats filesystems without change methods as read-only", async () => {
			const { stdout, run } = await fixture("fs-errors.bal", (files) => {
				const fs = new MemFS({ ...files, "dir/a.txt": "" });
				return {
					stat: (path) => fs.stat(path),
					readdir: (path) => fs.readdir(path),
					open: (path, flags) => {
						if (flags.write) throw new FsError("EROFS", path);
						const file = fs.open(path, flags);
						return { read: (offset, length) => file.read(offset, length) };
					},
				};
			});

			expect(await run()).toBe(0);
			expect(lines(stdout).at(-1)).toBe(
				"error while writing to file 'dir/new.txt': open dir/new.txt: Read-only file system",
			);
		});

		it("supports file operations with an in-memory filesystem", async () => {
			const { stdout, run } = await fixture("file-ops.bal");

			expect(await run()).toBe(0);
			expect(lines(stdout)).toEqual([...FILE_OPS_OUTPUT, unsupportedCopy("main.bal")]);
		});

		it("supports file operations with NodeFS", async () => {
			const root = await mkdtemp(join(tmpdir(), "balrun-"));
			try {
				const main = join(root, "main.bal");
				await Bun.write(main, Bun.file(new URL("./fixtures/file-ops.bal", import.meta.url)));
				const stdout: string[] = [];

				expect(
					await bridge.run(new NodeFS(), main, {
						stdout: { write: (chunk) => stdout.push(chunk) },
					}),
				).toBe(0);
				expect(lines(stdout)).toEqual([...FILE_OPS_OUTPUT, unsupportedCopy(main)]);
			} finally {
				await rm(root, { recursive: true });
			}
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
			expect(stderr.join("")).toBe("error: stat missing.bal: No such file or directory\n");
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
