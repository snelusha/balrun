import type { DirEntry, FS, OpenResult, StatResult } from "../src/fs/core";

export class MemFS implements FS {
	private files = new Map<string, string>();

	constructor(files: Record<string, string>) {
		for (const [path, content] of Object.entries(files)) {
			this.files.set(path, content);
		}
	}

	async open(path: string): Promise<OpenResult | null> {
		const content = this.files.get(path);
		if (content === undefined) return null;
		return {
			content,
			size: content.length,
			modTime: Date.now(),
			isDir: false,
		};
	}

	async stat(path: string): Promise<StatResult | null> {
		if (path === ".") {
			return {
				name: ".",
				size: 0,
				modTime: Date.now(),
				isDir: true,
			};
		}
		const content = this.files.get(path);
		if (content === undefined) return null;
		return {
			name: path,
			size: content.length,
			modTime: Date.now(),
			isDir: false,
		};
	}

	async readDir(path: string): Promise<DirEntry[] | null> {
		if (path !== ".") return null;
		return [...this.files.keys()].map((name) => ({
			name,
			isDir: false,
		}));
	}

	writeFile(_path: string, _content: string): Promise<boolean> {
		throw new Error("Method not implemented.");
	}
	remove(_path: string): Promise<boolean> {
		throw new Error("Method not implemented.");
	}
	move(_oldPath: string, _newPath: string): Promise<boolean> {
		throw new Error("Method not implemented.");
	}
	mkdirAll(_path: string): Promise<boolean> {
		throw new Error("Method not implemented.");
	}
}
