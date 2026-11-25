type FileEntry = { kind: "file"; data: Uint8Array; mtimeMs: number; writers: number };
type DirEntry = { kind: "directory"; children: Map<string, Entry>; removed: boolean };
type Entry = FileEntry | DirEntry;

/**
 * Installs an in-memory `navigator.storage.getDirectory()` that keeps the OPFS
 * behaviors `OPFS` has to work around, as seen in Chromium: writes appear on
 * close, files being written cannot be removed, snapshots die when their file
 * changes, and nothing can be moved.
 */
export class FakeOPFS {
	private readonly storage = Object.getOwnPropertyDescriptor(navigator, "storage");
	private readonly handleClass = Object.getOwnPropertyDescriptor(
		globalThis,
		"FileSystemFileHandle",
	);
	private readonly prototype: { createWritable?: unknown } = { createWritable: () => {} };
	failure: string | undefined;

	constructor() {
		const root = new DirHandle(this, "", createDir());
		Object.defineProperty(navigator, "storage", {
			configurable: true,
			value: { getDirectory: async () => root },
		});
		Object.defineProperty(globalThis, "FileSystemFileHandle", {
			configurable: true,
			value: { prototype: this.prototype },
		});
	}

	disableWrites(): void {
		delete this.prototype.createWritable;
	}

	failWrites(name: string | undefined): void {
		this.failure = name;
	}

	restore(): void {
		if (this.storage) Object.defineProperty(navigator, "storage", this.storage);
		else Reflect.deleteProperty(navigator, "storage");
		if (this.handleClass)
			Object.defineProperty(globalThis, "FileSystemFileHandle", this.handleClass);
		else Reflect.deleteProperty(globalThis, "FileSystemFileHandle");
	}
}

class FileHandle {
	readonly kind = "file";
	private readonly opfs: FakeOPFS;
	readonly name: string;
	private readonly parent: DirEntry;

	constructor(opfs: FakeOPFS, name: string, parent: DirEntry) {
		this.opfs = opfs;
		this.name = name;
		this.parent = parent;
	}

	private entry(): FileEntry {
		const entry = this.parent.children.get(this.name);
		if (this.parent.removed || entry?.kind !== "file") throw domError("NotFoundError");
		return entry;
	}

	async getFile() {
		const entry = this.entry();
		const { data, mtimeMs } = entry;
		return {
			size: data.length,
			lastModified: mtimeMs,
			arrayBuffer: async () => {
				if (this.entry() !== entry || entry.data !== data) throw domError("NotReadableError");
				return data.slice().buffer;
			},
		};
	}

	async createWritable() {
		const entry = this.entry();
		entry.writers++;
		let data = new Uint8Array();
		let open = true;
		const finish = () => {
			if (!open) throw new TypeError("stream is closed");
			open = false;
			entry.writers--;
		};
		return {
			write: async (chunk: Uint8Array | { arrayBuffer(): Promise<ArrayBuffer> }) => {
				const bytes =
					chunk instanceof Uint8Array ? chunk.slice() : new Uint8Array(await chunk.arrayBuffer());
				if (this.opfs.failure) throw domError(this.opfs.failure);
				const next = new Uint8Array(data.length + bytes.length);
				next.set(data);
				next.set(bytes, data.length);
				data = next;
			},
			close: async () => {
				await Bun.sleep(1);
				finish();
				entry.data = data;
				entry.mtimeMs = Date.now();
			},
			abort: async () => finish(),
		};
	}
}

class DirHandle {
	readonly kind = "directory";
	private readonly opfs: FakeOPFS;
	readonly name: string;
	private readonly dir: DirEntry;

	constructor(opfs: FakeOPFS, name: string, dir: DirEntry) {
		this.opfs = opfs;
		this.name = name;
		this.dir = dir;
	}

	private child(name: string): Entry | undefined {
		if (name === "" || name === "." || name === ".." || /[/\\]/.test(name))
			throw new TypeError("Name is not allowed.");
		if (this.dir.removed) throw domError("NotFoundError");
		return this.dir.children.get(name);
	}

	async getFileHandle(name: string, options?: { create?: boolean }) {
		const entry = this.child(name);
		if (entry?.kind === "directory") throw domError("TypeMismatchError");
		if (!entry) {
			if (!options?.create) throw domError("NotFoundError");
			this.dir.children.set(name, {
				kind: "file",
				data: new Uint8Array(),
				mtimeMs: Date.now(),
				writers: 0,
			});
		}
		return new FileHandle(this.opfs, name, this.dir);
	}

	async getDirectoryHandle(name: string, options?: { create?: boolean }) {
		let entry = this.child(name);
		if (entry?.kind === "file") throw domError("TypeMismatchError");
		if (!entry) {
			if (!options?.create) throw domError("NotFoundError");
			entry = createDir();
			this.dir.children.set(name, entry);
		}
		return new DirHandle(this.opfs, name, entry);
	}

	async removeEntry(name: string, options?: { recursive?: boolean }) {
		const entry = this.child(name);
		if (!entry) throw domError("NotFoundError");
		if (entry.kind === "directory" && entry.children.size > 0 && !options?.recursive)
			throw domError("InvalidModificationError");
		if (isLocked(entry)) throw domError("NoModificationAllowedError");
		this.dir.children.delete(name);
		markRemoved(entry);
	}

	async *values() {
		if (this.dir.removed) throw domError("NotFoundError");
		for (const [name, { kind }] of this.dir.children) {
			yield kind === "file"
				? new FileHandle(this.opfs, name, this.dir)
				: await this.getDirectoryHandle(name);
		}
	}
}

function createDir(): DirEntry {
	return { kind: "directory", children: new Map(), removed: false };
}

function isLocked(entry: Entry): boolean {
	if (entry.kind === "file") return entry.writers > 0;
	return Array.from(entry.children.values()).some(isLocked);
}

function markRemoved(entry: Entry): void {
	if (entry.kind === "file") return;
	entry.removed = true;
	for (const child of entry.children.values()) markRemoved(child);
}

function domError(name: string): DOMException {
	return new DOMException(name, name);
}
