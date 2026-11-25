import { Ballerina, FsError } from "@snelusha/balrun";

import type { Fs, FsDirEntry, FsFile, FsOpenFlags, FsStat } from "@snelusha/balrun";

// A read-only filesystem needs only `stat`, `readdir` and `open`. Add `mkdir`, `rm` and
// `rename`, and a `write` method on files, to let programs change it.
class MemFS implements Fs {
	private files = new Map<string, Uint8Array>();

	constructor(files: Record<string, string>) {
		for (const [path, content] of Object.entries(files)) {
			this.files.set(path, new TextEncoder().encode(content));
		}
	}

	stat(path: string): FsStat {
		if (path === ".") return { type: "dir", size: 0, mtimeMs: 0 };
		return { type: "file", size: this.read(path).length, mtimeMs: 0 };
	}

	readdir(path: string): FsDirEntry[] {
		if (path !== ".") throw new FsError("ENOENT", path);
		return Array.from(this.files.keys(), (name) => ({ name, type: "file" }));
	}

	open(path: string, flags: FsOpenFlags): FsFile {
		if (flags.write) throw new FsError("EROFS", path);
		if (path === ".") throw new FsError("EISDIR", path);
		const content = this.read(path);
		return { read: (offset, length) => content.subarray(offset, offset + length) };
	}

	private read(path: string): Uint8Array {
		const content = this.files.get(path);
		if (!content) throw new FsError("ENOENT", path);
		return content;
	}
}

const fs = new MemFS({
	"main.bal": `import ballerina/io;\npublic function main() { io:println("Hello, World!"); }`,
});

await new Ballerina({ fs }).run("main.bal");
