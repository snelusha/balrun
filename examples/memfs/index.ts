import { Ballerina } from "@snelusha/balrun";

import type { DirEntry, FS, OpenResult, StatResult } from "@snelusha/balrun";

// When running a single file, only `open` and `stat` are required.
// When running a package, `readDir` is also required.
class MemFS implements FS {
	private files = new Map<string, string>();

	constructor(files: Record<string, string>) {
		for (const [path, content] of Object.entries(files)) {
			this.files.set(path, content);
		}
	}

	async open(path: string): Promise<OpenResult | null> {
		const content = this.files.get(path);
		return content == null
			? null
			: { content, size: content.length, modTime: 0, isDir: false };
	}

	async stat(path: string): Promise<StatResult | null> {
		if (path === ".") {
			return { name: ".", size: 0, modTime: 0, isDir: true };
		}
		const content = this.files.get(path);
		return content == null
			? null
			: { name: path, size: content.length, modTime: 0, isDir: false };
	}

	async readDir(path: string): Promise<DirEntry[] | null> {
		if (path === ".") {
			return Array.from(this.files.keys()).map((name) => ({
				name,
				isDir: false,
			}));
		}
		return null;
	}

	async writeFile(): Promise<boolean> {
		throw new Error("not implemented");
	}
	async remove(): Promise<boolean> {
		throw new Error("not implemented");
	}
	async move(): Promise<boolean> {
		throw new Error("not implemented");
	}
	async mkdirAll(): Promise<boolean> {
		throw new Error("not implemented");
	}
}

const fs = new MemFS({
	"main.bal": `import ballerina/io;\npublic function main() { io:println("Hello, World!"); }`,
});

await new Ballerina({ fs }).run("main.bal");
