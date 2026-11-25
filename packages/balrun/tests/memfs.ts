import { FsError } from "../src/core/fs";

import type { Fs, FsDirEntry, FsFile, FsOpenFlags, FsStat } from "../src/core/fs";

type FileNode = { type: "file"; data: Uint8Array; mtimeMs: number };
type DirNode = { type: "dir"; children: Map<string, Node>; mtimeMs: number };
type Node = FileNode | DirNode;

export class MemFS implements Fs {
	private readonly root: DirNode = createDir();

	constructor(files: Record<string, string | Uint8Array>) {
		for (const [path, content] of Object.entries(files)) {
			const parent = path.split("/").slice(0, -1).join("/");
			if (parent !== "") this.mkdir(parent, { recursive: true });
			this.writeFile(
				path,
				typeof content === "string" ? new TextEncoder().encode(content) : content,
			);
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
		let node = this.find(path);
		if (node && flags.create && flags.exclusive) throw new FsError("EEXIST", path);
		if (!node) {
			if (!flags.create) throw new FsError("ENOENT", path);
			const [parent, name] = this.parentOf(path);
			node = createFile();
			parent.children.set(name, node);
		}
		if (node.type === "dir") throw new FsError("EISDIR", path);
		if (flags.truncate) node.data = new Uint8Array();
		return new MemFile(node, flags);
	}

	mkdir(path: string, options: { recursive: boolean }): void {
		if (!options.recursive) {
			const [parent, name] = this.parentOf(path);
			if (parent.children.has(name)) throw new FsError("EEXIST", path);
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
		if (to.startsWith(`${from}/`)) throw new FsError("EINVAL", to);
		const target = newParent.children.get(newName);
		if (target?.type === "dir" && node.type === "file") throw new FsError("EISDIR", to);
		if (target?.type === "file" && node.type === "dir") throw new FsError("ENOTDIR", to);
		if (target?.type === "dir" && target !== node && target.children.size > 0)
			throw new FsError("ENOTEMPTY", to);
		oldParent.children.delete(oldName);
		newParent.children.set(newName, node);
	}

	writeFile(path: string, data: Uint8Array): void {
		this.open(path, {
			read: false,
			write: true,
			create: true,
			truncate: true,
			append: false,
			exclusive: false,
		}).write?.(0, data);
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
		return this.node.data.slice(offset, offset + length);
	}

	stat(): FsStat {
		return toStat(this.node);
	}

	private writeAt(offset: number, data: Uint8Array): number {
		const { node } = this;
		const start = this.append ? node.data.length : offset;
		const next = new Uint8Array(Math.max(node.data.length, start + data.length));
		next.set(node.data);
		next.set(data, start);
		node.data = next;
		node.mtimeMs = Date.now();
		return data.length;
	}
}

function segments(path: string): string[] {
	return path.split("/").filter((name) => name !== "" && name !== ".");
}

function createFile(): FileNode {
	return { type: "file", data: new Uint8Array(), mtimeMs: Date.now() };
}

function createDir(): DirNode {
	return { type: "dir", children: new Map(), mtimeMs: Date.now() };
}

function toStat(node: Node): FsStat {
	return {
		type: node.type,
		size: node.type === "file" ? node.data.length : 0,
		mtimeMs: node.mtimeMs,
	};
}
