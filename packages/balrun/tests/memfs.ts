import type { DirEntry, FS, OpenResult, StatResult } from "../src/fs/core";

export class MemFS implements FS {
	private directories = new Set(["."]);
	private files = new Map<string, string>();

	constructor(files: Record<string, string>) {
		for (const [path, content] of Object.entries(files)) {
			this.addParentDirectories(path);
			this.files.set(path, content);
		}
	}

	async open(path: string): Promise<OpenResult | null> {
		if (this.directories.has(path))
			return { content: "", size: 0, modTime: Date.now(), isDir: true };

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
		if (this.directories.has(path))
			return { name: path, size: 0, modTime: Date.now(), isDir: true };

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

	async writeFile(path: string, content: string): Promise<boolean> {
		const separator = path.lastIndexOf("/");
		const parent = separator === -1 ? "." : path.slice(0, separator);
		if (
			this.directories.has(path) ||
			!this.directories.has(parent) ||
			!this.canCreateDirectory(parent)
		)
			return false;
		this.files.set(path, content);
		return true;
	}

	async mkdirAll(path: string): Promise<boolean> {
		if (!this.canCreateDirectory(path)) return false;
		this.addParentDirectories(path);
		this.directories.add(path);
		return true;
	}

	remove(_path: string): Promise<boolean> {
		throw new Error("Method not implemented.");
	}
	move(_oldPath: string, _newPath: string): Promise<boolean> {
		throw new Error("Method not implemented.");
	}

	private canCreateDirectory(path: string): boolean {
		const parts = path.split("/");
		for (let i = 1; i <= parts.length; i++) {
			if (this.files.has(parts.slice(0, i).join("/"))) return false;
		}
		return true;
	}

	private addParentDirectories(path: string): void {
		const parts = path.split("/");
		for (let i = 1; i < parts.length; i++) {
			this.directories.add(parts.slice(0, i).join("/"));
		}
	}
}
