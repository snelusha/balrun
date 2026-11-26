import { FsError } from "./fs";

import type { Fs, FsDirEntry, FsFile, FsOpenFlags, FsStat } from "./fs";

type FileNode = { type: "file"; data: Uint8Array; size: number; mtimeMs: number };
type DirNode = { type: "dir"; children: Map<string, Node>; mtimeMs: number };
type Node = FileNode | DirNode;

const WRITE_FILE: FsOpenFlags = {
	read: false,
	write: true,
	create: true,
	truncate: true,
	append: false,
	exclusive: false,
};

export class MemFS implements Fs {
	private readonly root: DirNode = createDir();

	constructor(files: Record<string, string | Uint8Array> = {}) {
		for (const [path, content] of Object.entries(files)) {
			this.mkdir(segments(path).slice(0, -1).join("/"), { recursive: true });
			this.writeFile(path, content);
		}
	}

	stat(path: string): FsStat {
		return toStat(this.get(path));
	}

	readdir(path: string): FsDirEntry[] {
		const entries = this.getDir(path).children;
		return Array.from(entries, ([name, node]) => ({ name, type: node.type }));
	}

	open(path: string, flags: FsOpenFlags): FsFile {
		return new MemFile(this.openNode(path, flags), flags);
	}

	mkdir(path: string, options: { recursive: boolean }): void {
		if (!options.recursive) {
			if (this.find(path)) throw new FsError("EEXIST", path);
			const [parent, name] = this.parentOf(path);
			parent.children.set(name, createDir());
			return;
		}
		let dir = this.root;
		for (const name of segments(path)) {
			let child = dir.children.get(name);
			if (!child) {
				child = createDir();
				dir.children.set(name, child);
			}
			if (child.type !== "dir") throw new FsError("ENOTDIR", path);
			dir = child;
		}
	}

	rm(path: string, options: { recursive: boolean }): void {
		const node = this.get(path);
		const [parent, name] = this.parentOf(path);
		if (node.type === "dir" && node.children.size > 0 && !options.recursive)
			throw new FsError("ENOTEMPTY", path);
		parent.children.delete(name);
	}

	rename(from: string, to: string): void {
		const node = this.get(from);
		const [oldParent, oldName] = this.parentOf(from);
		const [newParent, newName] = this.parentOf(to);
		const fromNames = segments(from);
		const toNames = segments(to);
		if (toNames.length > fromNames.length && fromNames.every((name, i) => name === toNames[i]))
			throw new FsError("EINVAL", to);
		const target = newParent.children.get(newName);
		if (target?.type === "dir" && node.type === "file") throw new FsError("EISDIR", to);
		if (target?.type === "file" && node.type === "dir") throw new FsError("ENOTDIR", to);
		if (target?.type === "dir" && target !== node && target.children.size > 0)
			throw new FsError("ENOTEMPTY", to);
		oldParent.children.delete(oldName);
		newParent.children.set(newName, node);
	}

	readFile(path: string): Uint8Array {
		const node = this.get(path);
		if (node.type === "dir") throw new FsError("EISDIR", path);
		return node.data.slice(0, node.size);
	}

	writeFile(path: string, data: Uint8Array | string): void {
		const node = this.openNode(path, WRITE_FILE);
		const content =
			typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
		node.data = content;
		node.size = content.length;
		node.mtimeMs = Date.now();
	}

	private openNode(path: string, flags: FsOpenFlags): FileNode {
		const node = this.find(path);
		if (!node) {
			if (!flags.create) throw new FsError("ENOENT", path);
			const [parent, name] = this.parentOf(path);
			const file = createFile();
			parent.children.set(name, file);
			return file;
		}
		if (flags.create && flags.exclusive) throw new FsError("EEXIST", path);
		if (node.type === "dir") throw new FsError("EISDIR", path);
		if (flags.truncate) {
			node.data = new Uint8Array();
			node.size = 0;
			node.mtimeMs = Date.now();
		}
		return node;
	}

	private find(path: string): Node | undefined {
		let node: Node = this.root;
		for (const name of segments(path)) {
			if (node.type !== "dir") throw new FsError("ENOTDIR", path);
			const child = node.children.get(name);
			if (!child) return undefined;
			node = child;
		}
		return node;
	}

	private get(path: string): Node {
		const node = this.find(path);
		if (!node) throw new FsError("ENOENT", path);
		return node;
	}

	private getDir(path: string): DirNode {
		const node = this.get(path);
		if (node.type !== "dir") throw new FsError("ENOTDIR", path);
		return node;
	}

	private parentOf(path: string): [DirNode, string] {
		const names = segments(path);
		const name = names.pop();
		if (name === undefined) throw new FsError("EBUSY", path);
		return [this.getDir(names.join("/")), name];
	}
}

class MemFile implements FsFile {
	private readonly node: FileNode;
	private readonly append: boolean;
	readonly write?: (offset: number, data: Uint8Array) => number;

	constructor(node: FileNode, flags: FsOpenFlags) {
		this.node = node;
		this.append = flags.append;
		if (flags.write) this.write = (offset, data) => this.writeAt(offset, data);
	}

	read(offset: number, length: number): Uint8Array {
		return this.node.data.slice(offset, Math.min(offset + length, this.node.size));
	}

	stat(): FsStat {
		return toStat(this.node);
	}

	private writeAt(offset: number, data: Uint8Array): number {
		const { node } = this;
		if (data.length === 0) return 0;
		const start = this.append ? node.size : offset;
		const end = start + data.length;
		if (end > node.data.length) {
			const grown = new Uint8Array(Math.max(end, node.data.length * 2));
			grown.set(node.data);
			node.data = grown;
		}
		node.data.set(data, start);
		node.size = Math.max(node.size, end);
		node.mtimeMs = Date.now();
		return data.length;
	}
}

function segments(path: string): string[] {
	const names: string[] = [];
	for (const name of path.split("/")) {
		if (name === "..") names.pop();
		else if (name !== "" && name !== ".") names.push(name);
	}
	return names;
}

function createFile(): FileNode {
	return { type: "file", data: new Uint8Array(), size: 0, mtimeMs: Date.now() };
}

function createDir(): DirNode {
	return { type: "dir", children: new Map(), mtimeMs: Date.now() };
}

function toStat(node: Node): FsStat {
	return {
		type: node.type,
		size: node.type === "file" ? node.size : 0,
		mtimeMs: node.mtimeMs,
	};
}
