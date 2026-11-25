import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FsError, NodeFS } from "../src/node";
import { MemFS } from "../src/core/memfs";
import { OPFS } from "../src/web/opfs";
import { FakeOPFS } from "./fake-opfs";

import type { Fs, FsFile, FsOpenFlags } from "../src/node";

const READ: FsOpenFlags = {
	read: true,
	write: false,
	create: false,
	truncate: false,
	append: false,
	exclusive: false,
};
const WRITE: FsOpenFlags = { ...READ, read: false, write: true, create: true };

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (data: Uint8Array) => new TextDecoder().decode(data);

async function withFile<T>(
	fs: Fs,
	path: string,
	flags: FsOpenFlags,
	use: (file: FsFile) => T | Promise<T>,
): Promise<T> {
	const file = await fs.open(path, flags);
	try {
		return await use(file);
	} finally {
		await file.close?.();
	}
}

const read = (fs: Fs, path: string) =>
	withFile(fs, path, READ, async (file) => decode(await file.read(0, 1024)));
const write = (fs: Fs, path: string, text: string, flags: FsOpenFlags = WRITE) =>
	withFile(fs, path, flags, async (file) => {
		expect(await file.write?.(0, encode(text))).toBe(encode(text).length);
	});

async function codeOf(operation: () => unknown): Promise<unknown> {
	try {
		await operation();
	} catch (error) {
		return (error as { code?: unknown }).code;
	}
	return undefined;
}

describe("FsError", () => {
	it("carries its code", () => {
		const error = new FsError("ENOENT", "missing.txt");
		expect(error).toBeInstanceOf(Error);
		expect(error.code).toBe("ENOENT");
		expect(error.message).toBe("ENOENT: missing.txt");
		expect(new FsError("EIO").message).toBe("EIO");
	});
});

describe.each(["NodeFS", "MemFS", "OPFS"])("%s", (name) => {
	let fs: Required<Pick<Fs, "mkdir" | "rm" | "rename" | "writeFile">> & Fs;
	let root: string;
	let opfs: FakeOPFS | undefined;
	const at = (path: string) => (root === "." ? path : join(root, path));

	beforeEach(async () => {
		root = name === "NodeFS" ? await mkdtemp(join(tmpdir(), "balrun-fs-")) : ".";
		if (name === "OPFS") opfs = new FakeOPFS();
		fs = name === "NodeFS" ? new NodeFS() : name === "MemFS" ? new MemFS({}) : new OPFS();
	});

	afterEach(async () => {
		opfs?.restore();
		opfs = undefined;
		if (root !== ".") await rm(root, { recursive: true });
	});

	it("reads at an offset and reports end of file", async () => {
		await write(fs, at("a.txt"), "abcdef");
		await withFile(fs, at("a.txt"), READ, async (file) => {
			expect(decode(await file.read(2, 3))).toBe("cde");
			expect(decode(await file.read(4, 10))).toBe("ef");
			expect(await file.read(6, 10)).toHaveLength(0);
			expect(await file.stat?.()).toMatchObject({ type: "file", size: 6 });
		});
	});

	it("writes at an offset and keeps the rest", async () => {
		await write(fs, at("a.txt"), "abcdef");
		await withFile(fs, at("a.txt"), WRITE, async (file) => {
			await file.write?.(2, encode("XY"));
		});
		expect(await read(fs, at("a.txt"))).toBe("abXYef");
	});

	it("honors truncate, append and exclusive", async () => {
		await write(fs, at("a.txt"), "first");
		await write(fs, at("a.txt"), " second", { ...WRITE, append: true });
		expect(await read(fs, at("a.txt"))).toBe("first second");
		await write(fs, at("a.txt"), "new", { ...WRITE, truncate: true });
		expect(await read(fs, at("a.txt"))).toBe("new");
		expect(await codeOf(() => fs.open(at("a.txt"), { ...WRITE, exclusive: true }))).toBe("EEXIST");
	});

	it("keeps bytes unchanged", async () => {
		const data = new Uint8Array([0xff, 0xfe, 0x00, 0x80]);
		await fs.writeFile(at("b.bin"), data);
		await withFile(fs, at("b.bin"), READ, async (file) => {
			expect(Array.from(await file.read(0, 10))).toEqual(Array.from(data));
		});
	});

	it("keeps open files working after a rename or removal", async () => {
		await write(fs, at("a.txt"), "content");
		await withFile(fs, at("a.txt"), READ, async (file) => {
			await fs.rename(at("a.txt"), at("b.txt"));
			expect(decode(await file.read(0, 10))).toBe("content");
			await fs.rm(at("b.txt"), { recursive: false });
			expect(decode(await file.read(0, 10))).toBe("content");
		});
	});

	it("lists and removes directories", async () => {
		await fs.mkdir(at("dir/nested"), { recursive: true });
		await fs.mkdir(at("dir/nested"), { recursive: true });
		await write(fs, at("dir/a.txt"), "a");
		const entries = await fs.readdir(at("dir"));
		expect(entries.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
			{ name: "a.txt", type: "file" },
			{ name: "nested", type: "dir" },
		]);
		expect((await fs.stat(at("dir"))).type).toBe("dir");

		expect(await codeOf(() => fs.rm(at("dir"), { recursive: false }))).toBe("ENOTEMPTY");
		await fs.rm(at("dir/nested"), { recursive: false });
		await fs.rm(at("dir"), { recursive: true });
		expect(await codeOf(() => fs.stat(at("dir")))).toBe("ENOENT");
	});

	it("refuses to move a directory into itself", async () => {
		await fs.mkdir(at("a/b"), { recursive: true });
		expect(await codeOf(() => fs.rename(at("a"), at("a/b/moved")))).toBe("EINVAL");
		if (root === ".") {
			expect(await codeOf(() => fs.rename("a", "./a/b/moved"))).toBe("EINVAL");
		}
		await fs.rename(at("a"), at("ab"));
		expect((await fs.stat(at("ab/b"))).type).toBe("dir");
	});

	it("throws errors with codes", async () => {
		await fs.mkdir(at("dir"), { recursive: false });
		await write(fs, at("file"), "");

		expect(await codeOf(() => fs.stat(at("missing")))).toBe("ENOENT");
		expect(await codeOf(() => fs.readdir(at("missing")))).toBe("ENOENT");
		expect(await codeOf(() => fs.open(at("missing"), READ))).toBe("ENOENT");
		expect(await codeOf(() => fs.open(at("dir"), READ))).toBe("EISDIR");
		expect(await codeOf(() => fs.open(at("dir"), WRITE))).toBe("EISDIR");
		expect(await codeOf(() => fs.readdir(at("file")))).toBe("ENOTDIR");
		expect(await codeOf(() => fs.stat(at("file/child")))).toBe("ENOTDIR");
		expect(await codeOf(() => fs.mkdir(at("dir"), { recursive: false }))).toBe("EEXIST");
		expect(await codeOf(() => fs.mkdir(at("file/child"), { recursive: true }))).toBe("ENOTDIR");
		expect(await codeOf(() => fs.rm(at("missing"), { recursive: true }))).toBe("ENOENT");
		expect(await codeOf(() => fs.rename(at("missing"), at("other")))).toBe("ENOENT");
	});
});

describe("MemFS", () => {
	it("is constructed from a plain object", () => {
		const source = Buffer.from("bytes");
		const fs = new MemFS({ "main.bal": "text", "./a/b/c.bin": source });
		source.fill(0);
		expect(decode(fs.readFile("main.bal"))).toBe("text");
		expect(decode(fs.readFile("a/b/c.bin"))).toBe("bytes");
		expect(new MemFS().readdir(".")).toEqual([]);
	});

	it("reads and writes whole files", async () => {
		const fs = new MemFS({ "a.txt": "a longer content" });
		fs.writeFile("a.txt", "short");
		const copy = fs.readFile("a.txt");
		expect(decode(copy)).toBe("short");
		copy.fill(0);
		expect(decode(fs.readFile("a.txt"))).toBe("short");
		expect(await codeOf(() => fs.writeFile("missing/a.txt", ""))).toBe("ENOENT");
		expect(await codeOf(() => fs.readFile("."))).toBe("EISDIR");
	});

	it("keeps contents exact while files grow", () => {
		const fs = new MemFS();
		const file = fs.open("a.txt", { ...WRITE, append: true });
		for (let i = 0; i < 100; i++) file.write?.(0, encode("abc"));
		expect(fs.stat("a.txt").size).toBe(300);
		expect(decode(fs.readFile("a.txt"))).toBe("abc".repeat(100));
		expect(file.read(299, 10)).toHaveLength(1);
		expect(file.read(300, 10)).toHaveLength(0);

		fs.open("gap", WRITE).write?.(3, encode("x"));
		expect(Array.from(fs.readFile("gap"))).toEqual([0, 0, 0, 120]);
	});

	it("resolves dot segments", async () => {
		const fs = new MemFS({ "a/b/c.txt": "c" });
		expect(decode(fs.readFile("/a/./x/../b/c.txt"))).toBe("c");
		expect(await codeOf(() => fs.mkdir(".", { recursive: false }))).toBe("EEXIST");
	});
});

describe("OPFS", () => {
	let opfs: FakeOPFS;
	let fs: OPFS;

	beforeEach(() => {
		opfs = new FakeOPFS();
		fs = new OPFS();
	});

	afterEach(() => opfs.restore());

	const saved = async (path: string) => decode(await new OPFS().readFile(path));

	it("keeps files for a new instance", async () => {
		await fs.mkdir("a/b", { recursive: true });
		await fs.writeFile("a/b/c.txt", "text");
		expect(await saved("a/b/c.txt")).toBe("text");
	});

	it("keeps to its root directory", async () => {
		const project = new OPFS({ root: "projects/one" });
		await project.writeFile("../../main.bal", "text");
		expect(await saved("projects/one/main.bal")).toBe("text");
		expect(await fs.readdir(".")).toEqual([{ name: "projects", type: "dir" }]);
	});

	it("is created without OPFS and recovers once it is available", async () => {
		opfs.restore();
		expect(await codeOf(() => fs.readdir("."))).toBe("ENOTSUP");
		opfs = new FakeOPFS();
		expect(await fs.readdir(".")).toEqual([]);
	});

	it("fails writes without creating files where they are not supported", async () => {
		await fs.writeFile("a.txt", "a");
		await fs.mkdir("dir", { recursive: false });
		opfs.disableWrites();
		expect(await codeOf(() => fs.open("b.txt", WRITE))).toBe("ENOTSUP");
		expect(await codeOf(() => fs.writeFile("b.txt", ""))).toBe("ENOTSUP");
		expect(await codeOf(() => fs.access("a.txt", "write"))).toBe("ENOTSUP");
		expect(await codeOf(() => fs.rename("a.txt", "b.txt"))).toBe("ENOTSUP");
		expect(await codeOf(() => fs.open("dir", WRITE))).toBe("EISDIR");
		expect(await codeOf(() => fs.stat("b.txt"))).toBe("ENOENT");
		expect(await read(fs, "a.txt")).toBe("a");
	});

	it("shares open files and saves them on close", async () => {
		await fs.writeFile("a.txt", "abc");
		const reader = await fs.open("a.txt", READ);
		const first = await fs.open("a.txt", { ...WRITE, append: true });
		const second = await fs.open("a.txt", { ...WRITE, append: true });
		first.write?.(0, encode("1"));
		second.write?.(0, encode("2"));

		expect(decode(await reader.read(0, 10))).toBe("abc12");
		expect(decode(await fs.readFile("a.txt"))).toBe("abc12");
		expect((await fs.stat("a.txt")).size).toBe(5);
		expect(await saved("a.txt")).toBe("abc");

		await first.close?.();
		expect(await saved("a.txt")).toBe("abc12");
		await second.close?.();
		await fs.writeFile("a.txt", "new");
		expect(decode(await reader.read(0, 10))).toBe("new");
		await reader.close?.();
		expect(await codeOf(() => reader.read(0, 1))).toBe("EBADF");
	});

	it("saves truncation and gaps", async () => {
		await fs.writeFile("a.txt", "content");
		await withFile(fs, "a.txt", { ...WRITE, truncate: true }, () => {});
		expect(await saved("a.txt")).toBe("");
		await withFile(fs, "a.txt", WRITE, async (file) => {
			await file.write?.(2, encode("x"));
		});
		expect(Array.from(await new OPFS().readFile("a.txt"))).toEqual([0, 0, 120]);
	});

	it("saves written files at their new path after a rename", async () => {
		await fs.mkdir("a", { recursive: false });
		const file = await fs.open("a/x.txt", WRITE);
		await file.write?.(0, encode("before "));
		await fs.rename("a", "b");
		await file.write?.(7, encode("after"));
		await file.close?.();
		expect(await saved("b/x.txt")).toBe("before after");
		expect(await codeOf(() => fs.stat("a"))).toBe("ENOENT");
	});

	it("does not save over a path that was removed, replaced or recreated", async () => {
		for (const change of [
			() => fs.rm("a.txt", { recursive: false }).then(() => fs.writeFile("a.txt", "new")),
			() => fs.writeFile("b.txt", "new").then(() => fs.rename("b.txt", "a.txt")),
		]) {
			await fs.writeFile("a.txt", "old");
			const file = await fs.open("a.txt", WRITE);
			await file.write?.(0, encode("stale"));
			await change();
			await file.close?.();
			expect(await saved("a.txt")).toBe("new");
		}
		const file = await fs.open("a.txt", WRITE);
		await file.write?.(0, encode("stale"));
		await fs.rm("a.txt", { recursive: false });
		await file.close?.();
		expect(await codeOf(() => fs.stat("a.txt"))).toBe("ENOENT");
	});

	it("orders operations that are not awaited", async () => {
		const file = await fs.open("a.txt", WRITE);
		await file.write?.(0, encode("text"));
		await Promise.all([file.close?.(), fs.rename("a.txt", "b.txt"), fs.rename("b.txt", "c.txt")]);
		expect(await saved("c.txt")).toBe("text");
		expect(await fs.readdir(".")).toEqual([{ name: "c.txt", type: "file" }]);
	});

	it("reports failed saves and keeps the previous contents", async () => {
		await fs.writeFile("a.txt", "old");
		opfs.failWrites("QuotaExceededError");
		const file = await fs.open("a.txt", { ...WRITE, truncate: true });
		await file.write?.(0, encode("new"));
		expect(await codeOf(() => file.close?.())).toBe("ENOSPC");
		expect(await codeOf(() => fs.writeFile("a.txt", "new"))).toBe("ENOSPC");
		expect(decode(await fs.readFile("a.txt"))).toBe("old");

		expect(await codeOf(() => fs.rename("a.txt", "b.txt"))).toBe("ENOSPC");
		expect(await fs.readdir(".")).toEqual([{ name: "a.txt", type: "file" }]);

		opfs.failWrites(undefined);
		await fs.mkdir("from", { recursive: false });
		await fs.mkdir("to", { recursive: false });
		await fs.writeFile("from/x.txt", "x");
		opfs.failWrites("QuotaExceededError");
		expect(await codeOf(() => fs.rename("from", "to"))).toBe("ENOSPC");
		expect(await saved("from/x.txt")).toBe("x");
		expect(await fs.readdir("to")).toEqual([]);
	});

	it("reports files locked elsewhere and invalid names", async () => {
		await fs.writeFile("a.txt", "a");
		const handle = await (await navigator.storage.getDirectory()).getFileHandle("a.txt");
		const writable = await handle.createWritable();
		expect(await codeOf(() => fs.rm("a.txt", { recursive: false }))).toBe("EBUSY");
		await writable.abort();
		expect(await codeOf(() => fs.writeFile("a\\b", ""))).toBe("EINVAL");
		expect(await codeOf(() => fs.rm(".", { recursive: true }))).toBe("EBUSY");
		expect(await codeOf(() => fs.rename("a.txt", "a.txt"))).toBeUndefined();
	});

	it("copies the data it is given", async () => {
		const data = encode("text");
		const writing = fs.writeFile("a.txt", data);
		data.fill(0);
		await writing;
		expect(await saved("a.txt")).toBe("text");
	});

	it("checks access without opening files", async () => {
		await fs.writeFile("a.txt", "a");
		await fs.access("a.txt", "write");
		await fs.access(".", "write");
		expect(await codeOf(() => fs.access("missing", "read"))).toBe("ENOENT");
	});
});

describe("NodeFS symbolic links", () => {
	it("follows links in stat and not in lstat", async () => {
		const root = await mkdtemp(join(tmpdir(), "balrun-fs-"));
		try {
			const fs = new NodeFS();
			await write(fs, join(root, "a.txt"), "a");
			await symlink("a.txt", join(root, "link"));
			expect((await fs.stat(join(root, "link"))).type).toBe("file");
			expect((await fs.lstat(join(root, "link"))).type).toBe("symlink");
		} finally {
			await rm(root, { recursive: true });
		}
	});
});
