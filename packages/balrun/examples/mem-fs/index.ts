import { Ballerina, type FS } from "@snelusha/balrun";

// When running a single file, only `open` and `stat` are required.
// When running a package, `readDir` is also required.
class MemFS implements FS {
	private files = new Map<string, string>();

	constructor(files: Record<string, string>) {
		for (const [path, content] of Object.entries(files)) {
			this.files.set(path, content);
		}
	}

	open(path: string) {
		const content = this.files.get(path);
		return content == null
			? null
			: { content, size: content.length, modTime: 0, isDir: false };
	}

	stat(path: string) {
		if (path === ".") {
			return { name: ".", size: 0, modTime: 0, isDir: true };
		}
		const content = this.files.get(path);
		return content == null
			? null
			: { name: path, size: content.length, modTime: 0, isDir: false };
	}

	readDir(path: string) {
		if (path === ".") {
			return Array.from(this.files.keys()).map((name) => ({
				name,
				isDir: false,
			}));
		}
		return null;
	}

	writeFile(): boolean {
		throw new Error("Method not implemented.");
	}
	remove(): boolean {
		throw new Error("Method not implemented.");
	}
	move(): boolean {
		throw new Error("Method not implemented.");
	}
	mkdirAll(): boolean {
		throw new Error("Method not implemented.");
	}
}

const fs = new MemFS({
	"main.bal": `import ballerina/io;\npublic function main() { io:println("Hello, World!"); }`,
});

await new Ballerina({ fs }).run("main.bal");
