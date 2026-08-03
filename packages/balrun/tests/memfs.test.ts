import { describe, expect, test } from "bun:test";

import { MemFS } from "./memfs";

describe("MemFS", () => {
	test("rejects file-directory conflicts without mutating the filesystem", async () => {
		const fs = new MemFS({ "file.txt": "content" });

		expect(await fs.writeFile("file.txt/child", "content")).toBe(false);
		expect(await fs.mkdirAll("file.txt/child")).toBe(false);
		expect(await fs.stat("file.txt/child")).toBeNull();

		expect(await fs.mkdirAll("directory")).toBe(true);
		expect(await fs.writeFile("directory", "content")).toBe(false);
		expect((await fs.stat("directory"))?.isDir).toBe(true);
	});
});
