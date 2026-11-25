import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FsError, NodeFS } from "../src/node";
import { MemFS } from "./memfs";

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

describe.each(["NodeFS", "MemFS"])("%s", (name) => {
	let fs: Required<Pick<Fs, "mkdir" | "rm" | "rename" | "writeFile">> & Fs;
	let root: string;
	const at = (path: string) => (root === "." ? path : join(root, path));

	beforeEach(async () => {
		root = name === "NodeFS" ? await mkdtemp(join(tmpdir(), "balrun-fs-")) : ".";
		fs = name === "NodeFS" ? new NodeFS() : new MemFS({});
	});

	afterEach(async () => {
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
