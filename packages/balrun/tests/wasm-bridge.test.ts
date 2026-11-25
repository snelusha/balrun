import { beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { FsError, NodeFS, WasmBridge } from "../src/node";
import { MemFS } from "./memfs";

import type { WasmExports } from "../src/core/bridge";
import type { Fs, FsFile, FsOpenFlags } from "../src/node";

const WASM_PATH = new URL("../dist/ballerina.wasm", import.meta.url).href;

const READ: FsOpenFlags = {
	read: true,
	write: false,
	create: false,
	truncate: false,
	append: false,
	exclusive: false,
};

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

	describe("exports", () => {
		const names = ["run", "stop", "version", "dispatchHttpRequest"];
		const handoffKey = "__balrun_exports__";

		it("does not touch globals", async () => {
			const originals = names.map(
				(name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
			);
			const sentinel = () => {};
			for (const name of names)
				Object.defineProperty(globalThis, name, {
					value: sentinel,
					configurable: true,
					writable: true,
				});

			try {
				await (await WasmBridge.load(WASM_PATH)).version();
				for (const name of names) expect(Reflect.get(globalThis, name)).toBe(sentinel);
				expect(handoffKey in globalThis).toBe(false);
			} finally {
				for (const [name, descriptor] of originals) {
					if (descriptor) Object.defineProperty(globalThis, name, descriptor);
					else Reflect.deleteProperty(globalThis, name);
				}
			}
		});

		it("keeps bridges independent", async () => {
			const { fs } = await fixture("http-listener.bal");
			const listening = Promise.withResolvers<void>();
			const run = bridge.run(fs, "main.bal", { onListenerReady: () => listening.resolve() });
			await listening.promise;

			const other = await WasmBridge.load(WASM_PATH);
			expect(other.stop("graceful")).toBe(false);
			const response = await bridge.dispatchHttpRequest({
				host: "localhost",
				port: 6969,
				path: "/ping",
			});
			expect(new TextDecoder().decode(response.body)).toBe("pong");
			expect(bridge.stop("graceful")).toBe(true);
			expect(await run).toBe(130);
		});

		it("supports concurrent loads", async () => {
			const bridges = await Promise.all([WasmBridge.load(WASM_PATH), WasmBridge.load(WASM_PATH)]);
			const source = await Bun.file(new URL("./fixtures/hello.bal", import.meta.url)).text();

			const outputs = await Promise.all(
				bridges.map(async (bridge) => {
					const stdout: string[] = [];
					const exitCode = await bridge.run(new MemFS({ "main.bal": source }), "main.bal", {
						stdout: { write: (chunk) => stdout.push(chunk) },
					});
					return [exitCode, stdout.join("")];
				}),
			);
			expect(outputs).toEqual([
				[0, "Hello, Ballerina!\n"],
				[0, "Hello, Ballerina!\n"],
			]);
		});

		it("rejects and cleans up when the module fails to start", async () => {
			const emptyModule = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
			const load = WasmBridge.load(new Response(emptyModule));
			expect(await load.catch((error) => error)).toBeInstanceOf(Error);
			expect(handoffKey in globalThis).toBe(false);
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
			expect(Array.from(await fs.open("b.bin", READ).read(0, 16))).toEqual([
				0xff, 0xfe, 0x00, 0x80,
			]);
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
				override open(path: string, flags: FsOpenFlags): FsFile {
					if (path !== "denied.txt") return super.open(path, flags);
					return {
						// oxlint-disable-next-line unicorn/no-thenable
						then() {
							throw new FsError("EACCES");
						},
					} as unknown as FsFile;
				}
			}
			const { stdout, run } = await fixture("fs-errors.bal", (files) => new ThrowingFS(files));

			expect(await run()).toBe(0);
			expect(lines(stdout)).toContain(
				"error while reading file 'denied.txt': open denied.txt: Permission denied",
			);
		});

		it("preserves error codes", async () => {
			class FailingFS extends MemFS {
				override open(path: string, flags: FsOpenFlags): FsFile {
					if (path === "denied.txt") throw new FsError("EACCES");
					if (path === "broken.txt") throw new Error("disk on fire");
					if (path === "thrown.txt") throw undefined;
					if (path === "dir/new.txt") throw new FsError("ENOSPC");
					return super.open(path, flags);
				}
			}
			const { stdout, run } = await fixture("fs-errors.bal", (files) => {
				const fs = new FailingFS(files);
				fs.mkdir("dir", { recursive: true });
				return fs;
			});

			expect(await run()).toBe(0);
			expect(lines(stdout)).toEqual([
				"error while reading file 'missing.txt': open missing.txt: No such file or directory",
				"error while reading file 'dir': open dir: Is a directory",
				"error while reading file 'denied.txt': open denied.txt: Permission denied",
				"error while reading file 'broken.txt': open broken.txt: disk on fire",
				"error while reading file 'thrown.txt': open thrown.txt: I/O error",
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
