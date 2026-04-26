import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NodeFS } from "./node-fs";

describe("NodeFS", () => {
	let rootDir: string;
	let sut: NodeFS;

	beforeEach(async () => {
		rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "balrun-nodefs-"));
		sut = new NodeFS();
	});

	afterEach(async () => {
		await fs.rm(rootDir, { recursive: true, force: true });
	});

	it("open returns file content and metadata for files", async () => {
		const filePath = path.join(rootDir, "hello.txt");
		await fs.writeFile(filePath, "hello world", "utf-8");

		const result = await sut.open(filePath);

		expect(result).not.toBeNull();
		expect(result).toMatchObject({
			content: "hello world",
			size: 11,
			isDir: false,
		});
		expect(typeof result?.modTime).toBe("number");
	});

	it("open returns directory metadata for directories", async () => {
		const dirPath = path.join(rootDir, "dir");
		await fs.mkdir(dirPath);

		const result = await sut.open(dirPath);

		expect(result).not.toBeNull();
		expect(result).toMatchObject({
			content: "",
			isDir: true,
		});
		expect(typeof result?.size).toBe("number");
		expect(typeof result?.modTime).toBe("number");
	});

	it("open returns null when path does not exist", async () => {
		const result = await sut.open(path.join(rootDir, "missing.txt"));
		expect(result).toBeNull();
	});

	it("stat returns file metadata", async () => {
		const filePath = path.join(rootDir, "main.bal");
		await fs.writeFile(filePath, "import ballerina/io;", "utf-8");

		const result = await sut.stat(filePath);

		expect(result).not.toBeNull();
		expect(result).toMatchObject({
			name: "main.bal",
			size: 20,
			isDir: false,
		});
		expect(typeof result?.modTime).toBe("number");
	});

	it("stat returns null when path does not exist", async () => {
		const result = await sut.stat(path.join(rootDir, "missing"));
		expect(result).toBeNull();
	});

	it("readDir returns entries with directory flags", async () => {
		const dirPath = path.join(rootDir, "pkg");
		await fs.mkdir(dirPath);
		await fs.mkdir(path.join(dirPath, "modules"));
		await fs.writeFile(path.join(dirPath, "Ballerina.toml"), "[package]", "utf-8");

		const result = await sut.readDir(dirPath);

		expect(result).not.toBeNull();
		expect(result).toEqual(
			expect.arrayContaining([
				{ name: "modules", isDir: true },
				{ name: "Ballerina.toml", isDir: false },
			]),
		);
	});

	it("readDir returns null for missing directory", async () => {
		const result = await sut.readDir(path.join(rootDir, "missing-dir"));
		expect(result).toBeNull();
	});

	it("writeFile writes content and returns true", async () => {
		const filePath = path.join(rootDir, "new.txt");

		const ok = await sut.writeFile(filePath, "created");

		expect(ok).toBe(true);
		await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("created");
	});

	it("writeFile returns false when parent directory is missing", async () => {
		const filePath = path.join(rootDir, "missing", "new.txt");
		const ok = await sut.writeFile(filePath, "created");
		expect(ok).toBe(false);
	});

	it("remove deletes files and directories", async () => {
		const filePath = path.join(rootDir, "to-remove.txt");
		const dirPath = path.join(rootDir, "to-remove-dir");
		await fs.writeFile(filePath, "x", "utf-8");
		await fs.mkdir(dirPath);

		await expect(sut.remove(filePath)).resolves.toBe(true);
		await expect(sut.remove(dirPath)).resolves.toBe(true);
		await expect(fs.stat(filePath)).rejects.toThrow();
		await expect(fs.stat(dirPath)).rejects.toThrow();
	});

	it("move renames a file and returns true", async () => {
		const oldPath = path.join(rootDir, "old.txt");
		const newPath = path.join(rootDir, "new.txt");
		await fs.writeFile(oldPath, "payload", "utf-8");

		const ok = await sut.move(oldPath, newPath);

		expect(ok).toBe(true);
		await expect(fs.readFile(newPath, "utf-8")).resolves.toBe("payload");
		await expect(fs.stat(oldPath)).rejects.toThrow();
	});

	it("move returns false when source does not exist", async () => {
		const ok = await sut.move(
			path.join(rootDir, "missing.txt"),
			path.join(rootDir, "other.txt"),
		);
		expect(ok).toBe(false);
	});

	it("mkdirAll creates nested directories and returns true", async () => {
		const nestedPath = path.join(rootDir, "a", "b", "c");

		const ok = await sut.mkdirAll(nestedPath);

		expect(ok).toBe(true);
		await expect(fs.stat(nestedPath)).resolves.toBeTruthy();
	});
});
