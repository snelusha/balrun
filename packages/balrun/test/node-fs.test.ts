import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { NodeFS } from "../src/fs/node";

let root: string;
let nodeFs: NodeFS;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "balrun-node-fs-"));
	nodeFs = new NodeFS();
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

describe("NodeFS", () => {
	test("reads files, directories, and stat metadata", async () => {
		const dir = path.join(root, "src");
		const file = path.join(dir, "main.bal");
		await fs.mkdir(dir);
		await fs.writeFile(file, "public function main() {}", "utf-8");

		const openedFile = await nodeFs.open(file);
		const openedDir = await nodeFs.open(dir);
		const stat = await nodeFs.stat(file);
		const entries = await nodeFs.readDir(dir);

		expect(openedFile).toMatchObject({
			content: "public function main() {}",
			isDir: false,
		});
		expect(openedFile?.size).toBeGreaterThan(0);
		expect(openedDir).toMatchObject({ content: "", isDir: true });
		expect(stat).toMatchObject({ name: "main.bal", isDir: false });
		expect(entries).toEqual([{ name: "main.bal", isDir: false }]);
	});

	test("creates, writes, moves, and removes paths", async () => {
		const dir = path.join(root, "generated", "nested");
		const file = path.join(dir, "a.txt");
		const moved = path.join(dir, "b.txt");

		expect(await nodeFs.mkdirAll(dir)).toBe(true);
		expect(await nodeFs.writeFile(file, "hello")).toBe(true);
		expect(await nodeFs.move(file, moved)).toBe(true);
		expect(await nodeFs.open(file)).toBeNull();
		expect(await nodeFs.open(moved)).toMatchObject({ content: "hello" });
		expect(await nodeFs.remove(path.join(root, "generated"))).toBe(true);
		expect(await nodeFs.stat(dir)).toBeNull();
	});

	test("returns null or false when filesystem operations fail", async () => {
		const missing = path.join(root, "missing.txt");
		const missingParentFile = path.join(root, "missing", "file.txt");

		expect(await nodeFs.open(missing)).toBeNull();
		expect(await nodeFs.stat(missing)).toBeNull();
		expect(await nodeFs.readDir(missing)).toBeNull();
		expect(await nodeFs.writeFile(missingParentFile, "nope")).toBe(false);
		expect(await nodeFs.move(missing, path.join(root, "new.txt"))).toBe(false);
	});
});
