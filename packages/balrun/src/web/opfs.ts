import { FsError } from "../core/fs";
import { segments } from "../core/path";

import type { Fs, FsDirEntry, FsFile, FsOpenFlags, FsStat } from "../core/fs";

export interface OPFSOptions {
	/** Directory inside the origin private file system to use as the root. Created when missing. */
	root?: string;
}

type Handle = FileSystemFileHandle | FileSystemDirectoryHandle;

/**
 * Filesystem persisted in the browser's Origin Private File System.
 *
 * Open files are held in memory and shared by everything that opens the same
 * path: OPFS snapshots do not survive a change to the file, and its writable
 * streams lock the file and hide their writes until closed. Changes are saved
 * when a file opened for writing is closed. Use one instance per root.
 */
export class OPFS implements Fs {
	private readonly root: string[];
	private rootHandle: Promise<FileSystemDirectoryHandle> | undefined;
	private readonly nodes = new Map<string, OpenNode>();
	private queue: Promise<unknown> = Promise.resolve();

	constructor(options: OPFSOptions = {}) {
		this.root = segments(options.root ?? "");
	}

	stat(path: string): Promise<FsStat> {
		return this.run(path, async (names) => {
			const handle = await this.get(names, path);
			if (handle.kind === "directory") return { type: "dir", size: 0, mtimeMs: 0 };
			const node = this.nodes.get(keyOf(names));
			if (node) return node.stat();
			const file = await handle.getFile();
			return { type: "file", size: file.size, mtimeMs: file.lastModified };
		});
	}

	readdir(path: string): Promise<FsDirEntry[]> {
		return this.run(path, async (names) => {
			const dir = await this.getDir(names, path);
			const entries: FsDirEntry[] = [];
			for await (const { name, kind } of dir.values())
				entries.push({ name, type: kind === "directory" ? "dir" : "file" });
			return entries;
		});
	}

	open(path: string, flags: FsOpenFlags): Promise<FsFile> {
		return this.run(path, async (names) => {
			const node = await this.openNode(names, path, flags);
			node.refs++;
			return new OPFSFile(node, flags, () => this.closeNode(node, path, flags.write));
		});
	}

	access(path: string, mode: "read" | "write"): Promise<void> {
		return this.run(path, async (names) => {
			const handle = await this.get(names, path);
			if (mode === "write" && handle.kind === "file") requireWritable(path);
		});
	}

	mkdir(path: string, options: { recursive: boolean }): Promise<void> {
		return this.run(path, async (names) => {
			if (options.recursive) {
				await this.getDir(names, path, true);
				return;
			}
			if (await this.find(names, path)) throw new FsError("EEXIST", path);
			const [parent, name] = await this.parentOf(names, path);
			await parent.getDirectoryHandle(name, { create: true });
		});
	}

	rm(path: string, options: { recursive: boolean }): Promise<void> {
		return this.run(path, async (names) => {
			const [parent, name] = await this.parentOf(names, path);
			await this.get(names, path);
			await parent.removeEntry(name, { recursive: options.recursive });
			this.detach(keyOf(names));
		});
	}

	/** Copies and then removes the source, as OPFS has no portable way to move. Not atomic. */
	rename(from: string, to: string): Promise<void> {
		return this.run(from, async (names) => {
			const toNames = segments(to);
			const [fromKey, toKey] = [keyOf(names), keyOf(toNames)];
			const source = await this.get(names, from);
			const [oldParent, oldName] = await this.parentOf(names, from);
			if (fromKey === toKey) return;
			if (source.kind === "directory" && isInside(toKey, fromKey)) throw new FsError("EINVAL", to);

			const [newParent, newName] = await this.parentOf(toNames, to);
			const target = await this.find(toNames, to);
			if (target?.kind === "directory") {
				if (source.kind === "file") throw new FsError("EISDIR", to);
				if (!(await isEmpty(target))) throw new FsError("ENOTEMPTY", to);
			} else if (target && source.kind === "directory") {
				throw new FsError("ENOTDIR", to);
			}

			requireWritable(to);
			try {
				await copy(source, newParent, newName);
			} catch (error) {
				// A file target is only replaced as a whole, so it still has its contents.
				if (target?.kind !== "file") {
					await newParent.removeEntry(newName, { recursive: true }).catch(() => {});
					if (target) await newParent.getDirectoryHandle(newName, { create: true }).catch(() => {});
				}
				throw error;
			}
			this.detach(toKey);
			await oldParent.removeEntry(oldName, { recursive: true });

			for (const [key, node] of this.nodes) {
				if (key !== fromKey && !isInside(key, fromKey)) continue;
				this.nodes.delete(key);
				node.key = toKey + key.slice(fromKey.length);
				this.nodes.set(node.key, node);
			}
		});
	}

	readFile(path: string): Promise<Uint8Array> {
		return this.run(path, async (names) => {
			const handle = await this.get(names, path);
			if (handle.kind === "directory") throw new FsError("EISDIR", path);
			return this.nodes.get(keyOf(names))?.contents() ?? readAll(handle);
		});
	}

	writeFile(path: string, data: Uint8Array | string): Promise<void> {
		const content = typeof data === "string" ? new TextEncoder().encode(data) : data.slice();
		return this.run(path, async (names) => {
			requireWritable(path);
			const [handle, created] = await this.getFile(names, path, true);
			if (created) this.detach(keyOf(names));
			await save(handle, content);
			this.nodes.get(keyOf(names))?.replace(content);
		});
	}

	/**
	 * Runs one operation at a time: each takes several asynchronous steps, and
	 * OPFS rejects changes to a file that is being written.
	 */
	private run<T>(path: string, operation: (names: string[]) => Promise<T>): Promise<T> {
		const result = this.queue.then(async () => {
			try {
				return await operation(segments(path));
			} catch (error) {
				throw toFsError(error, path);
			}
		});
		this.queue = result.catch(() => {});
		return result;
	}

	private async openNode(names: string[], path: string, flags: FsOpenFlags): Promise<OpenNode> {
		const existing = await this.find(names, path);
		if (existing && flags.create && flags.exclusive) throw new FsError("EEXIST", path);
		// Checked before a file is created, but directories still fail with EISDIR.
		if (flags.write && existing?.kind !== "directory") requireWritable(path);

		const [handle, created] = await this.getFile(names, path, flags.create);
		const key = keyOf(names);
		// The file an open node belongs to may have been removed by another tab.
		if (created) this.detach(key);
		let node = this.nodes.get(key);
		const truncate = flags.truncate && flags.write;
		if (!node) {
			const file = await handle.getFile();
			const data = truncate ? new Uint8Array() : new Uint8Array(await file.arrayBuffer());
			node = new OpenNode(key, data, file.lastModified);
			this.nodes.set(key, node);
			if (truncate && file.size > 0) node.truncate();
		} else if (truncate) {
			node.truncate();
		}
		return node;
	}

	private closeNode(node: OpenNode, path: string, write: boolean): Promise<void> {
		return this.run(path, async () => {
			try {
				if (!write || !node.dirty || this.nodes.get(node.key) !== node) return;
				const { version } = node;
				const [handle] = await this.getFile(segments(node.key), path, false);
				await save(handle, node.contents());
				node.savedVersion = version;
			} finally {
				node.refs--;
				if (node.refs === 0 && this.nodes.get(node.key) === node) this.nodes.delete(node.key);
			}
		});
	}

	/** Cuts open files off from a path that no longer belongs to them. */
	private detach(path: string): void {
		for (const key of this.nodes.keys()) {
			if (key === path || isInside(key, path)) this.nodes.delete(key);
		}
	}

	private openRoot(): Promise<FileSystemDirectoryHandle> {
		this.rootHandle ??= (async () => {
			const storage = globalThis.navigator?.storage;
			if (!storage?.getDirectory)
				throw new FsError("ENOTSUP", "the origin private file system is not available");
			let dir = await storage.getDirectory();
			for (const name of this.root) dir = await dir.getDirectoryHandle(name, { create: true });
			return dir;
		})().catch((error) => {
			this.rootHandle = undefined;
			throw error;
		});
		return this.rootHandle;
	}

	private async getDir(
		names: string[],
		path: string,
		create = false,
	): Promise<FileSystemDirectoryHandle> {
		let dir = await this.openRoot();
		for (const name of names) {
			try {
				dir = await dir.getDirectoryHandle(name, { create });
			} catch (error) {
				throw isError(error, "TypeMismatchError") ? new FsError("ENOTDIR", path) : error;
			}
		}
		return dir;
	}

	private async parentOf(
		names: string[],
		path: string,
	): Promise<[FileSystemDirectoryHandle, string]> {
		const name = names.at(-1);
		if (name === undefined) throw new FsError("EBUSY", path);
		return [await this.getDir(names.slice(0, -1), path), name];
	}

	private async find(names: string[], path: string): Promise<Handle | undefined> {
		if (names.length === 0) return this.openRoot();
		const [parent, name] = await this.parentOf(names, path);
		try {
			return await parent.getFileHandle(name);
		} catch (error) {
			if (isError(error, "NotFoundError")) return undefined;
			if (isError(error, "TypeMismatchError")) return parent.getDirectoryHandle(name);
			throw error;
		}
	}

	private async get(names: string[], path: string): Promise<Handle> {
		const handle = await this.find(names, path);
		if (!handle) throw new FsError("ENOENT", path);
		return handle;
	}

	/** Returns the file and whether it was created. */
	private async getFile(
		names: string[],
		path: string,
		create: boolean,
	): Promise<[FileSystemFileHandle, boolean]> {
		const handle = await this.find(names, path);
		if (handle?.kind === "directory") throw new FsError("EISDIR", path);
		if (handle) return [handle, false];
		if (!create) throw new FsError("ENOENT", path);
		const [parent, name] = await this.parentOf(names, path);
		return [await parent.getFileHandle(name, { create: true }), true];
	}
}

/** The contents of an open file, shared by every handle to it. */
class OpenNode {
	key: string;
	refs = 0;
	version = 0;
	savedVersion = 0;
	private data: Uint8Array;
	private size: number;
	private mtimeMs: number;

	constructor(key: string, data: Uint8Array, mtimeMs: number) {
		this.key = key;
		this.data = data;
		this.size = data.length;
		this.mtimeMs = mtimeMs;
	}

	get dirty(): boolean {
		return this.version !== this.savedVersion;
	}

	stat(): FsStat {
		return { type: "file", size: this.size, mtimeMs: this.mtimeMs };
	}

	contents(): Uint8Array<ArrayBuffer> {
		return this.read(0, this.size);
	}

	read(offset: number, length: number): Uint8Array<ArrayBuffer> {
		return new Uint8Array(this.data.subarray(offset, Math.min(offset + length, this.size)));
	}

	write(offset: number | undefined, data: Uint8Array): number {
		if (data.length === 0) return 0;
		const start = offset ?? this.size;
		const end = start + data.length;
		if (end > this.data.length) {
			const grown = new Uint8Array(Math.max(end, this.data.length * 2));
			grown.set(this.data);
			this.data = grown;
		}
		this.data.set(data, start);
		this.size = Math.max(this.size, end);
		this.changed();
		return data.length;
	}

	truncate(): void {
		this.data = new Uint8Array();
		this.size = 0;
		this.changed();
	}

	/** Takes contents that are already saved. */
	replace(data: Uint8Array): void {
		this.data = data;
		this.size = data.length;
		this.changed();
		this.savedVersion = this.version;
	}

	private changed(): void {
		this.version++;
		this.mtimeMs = Date.now();
	}
}

class OPFSFile implements FsFile {
	private readonly node: OpenNode;
	private readonly onClose: () => Promise<void>;
	private closed = false;
	readonly write?: (offset: number, data: Uint8Array) => number;

	constructor(node: OpenNode, flags: FsOpenFlags, onClose: () => Promise<void>) {
		this.node = node;
		this.onClose = onClose;
		if (flags.write) {
			this.write = (offset, data) => {
				this.requireOpen();
				return node.write(flags.append ? undefined : offset, data);
			};
		}
	}

	read(offset: number, length: number): Uint8Array {
		this.requireOpen();
		return this.node.read(offset, length);
	}

	stat(): FsStat {
		this.requireOpen();
		return this.node.stat();
	}

	async close(): Promise<void> {
		this.requireOpen();
		this.closed = true;
		await this.onClose();
	}

	private requireOpen(): void {
		if (this.closed) throw new FsError("EBADF");
	}
}

function keyOf(names: string[]): string {
	return names.join("/");
}

function isInside(key: string, dir: string): boolean {
	return key.startsWith(`${dir}/`);
}

function canWrite(): boolean {
	return typeof globalThis.FileSystemFileHandle?.prototype.createWritable === "function";
}

function requireWritable(path: string): void {
	if (!canWrite())
		throw new FsError("ENOTSUP", `${path}: this browser cannot write to OPFS from a page`);
}

async function readAll(handle: FileSystemFileHandle): Promise<Uint8Array> {
	return new Uint8Array(await (await handle.getFile()).arrayBuffer());
}

/** Replaces the whole file, or leaves it unchanged on failure. */
async function save(
	handle: FileSystemFileHandle,
	data: Uint8Array<ArrayBuffer> | Blob,
): Promise<void> {
	const writable = await handle.createWritable();
	try {
		await writable.write(data);
		await writable.close();
	} catch (error) {
		await writable.abort().catch(() => {});
		throw error;
	}
}

async function copy(
	source: Handle,
	parent: FileSystemDirectoryHandle,
	name: string,
): Promise<void> {
	if (source.kind === "file") {
		const target = await parent.getFileHandle(name, { create: true });
		return save(target, await source.getFile());
	}
	const target = await parent.getDirectoryHandle(name, { create: true });
	for await (const child of source.values()) await copy(child, target, child.name);
}

async function isEmpty(dir: FileSystemDirectoryHandle): Promise<boolean> {
	for await (const _ of dir.values()) return false;
	return true;
}

function isError(error: unknown, name: string): boolean {
	return error instanceof Error && error.name === name;
}

const CODES: Record<string, string> = {
	InvalidModificationError: "ENOTEMPTY",
	NoModificationAllowedError: "EBUSY",
	NotAllowedError: "EACCES",
	NotFoundError: "ENOENT",
	QuotaExceededError: "ENOSPC",
	SecurityError: "EACCES",
	TypeError: "EINVAL", // a name OPFS does not allow
};

function toFsError(error: unknown, path: string): unknown {
	if (error instanceof FsError || !(error instanceof Error)) return error;
	const code = CODES[error.name];
	return code === undefined ? error : new FsError(code, `${path}: ${error.message}`);
}
