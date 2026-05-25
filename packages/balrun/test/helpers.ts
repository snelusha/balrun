import type { DirEntry, FS, OpenResult, StatResult } from "../src/fs/core";

export class MemFS implements FS {
	private files = new Map<string, string>();

	constructor(files: Record<string, string>) {
		for (const [path, content] of Object.entries(files)) {
			this.files.set(path, content);
		}
	}

	set(path: string, content: string) {
		this.files.set(path, content);
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
		if (path !== ".") return null;
		return Array.from(this.files.keys()).map((name) => ({
			name,
			isDir: false,
		}));
	}

	async writeFile(path: string, content: string): Promise<boolean> {
		this.files.set(path, content);
		return true;
	}

	async remove(path: string): Promise<boolean> {
		this.files.delete(path);
		return true;
	}

	async move(oldPath: string, newPath: string): Promise<boolean> {
		const content = this.files.get(oldPath);
		if (content == null) return false;
		this.files.delete(oldPath);
		this.files.set(newPath, content);
		return true;
	}

	async mkdirAll(): Promise<boolean> {
		return true;
	}
}
