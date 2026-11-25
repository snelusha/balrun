import { constants } from "node:fs";
import {
	access,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	rename,
	rm,
	rmdir,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";

import type { FileHandle } from "node:fs/promises";

import { FsError } from "../core/fs";

import type { Fs, FsDirEntry, FsFile, FsFileType, FsOpenFlags, FsStat } from "../core/fs";

/**
 * Node.js filesystem implementation for the Ballerina runtime.
 */
export class NodeFS implements Fs {
	readonly supportsAbsolutePaths = true;

	cwd(): string {
		return process.cwd();
	}

	async stat(path: string): Promise<FsStat> {
		return toFsStat(await stat(path));
	}

	async lstat(path: string): Promise<FsStat> {
		return toFsStat(await lstat(path));
	}

	async readdir(path: string): Promise<FsDirEntry[]> {
		const entries = await readdir(path, { withFileTypes: true });
		return entries.map((entry) => ({ name: entry.name, type: fileType(entry) }));
	}

	async open(path: string, flags: FsOpenFlags): Promise<FsFile> {
		const handle = await open(path, openFlags(flags));
		try {
			const stats = await handle.stat();
			if (stats.isDirectory()) throw new FsError("EISDIR", path);
			return new NodeFile(handle, stats.isFile(), flags.append);
		} catch (error) {
			await handle.close();
			throw error;
		}
	}

	access(path: string, mode: "read" | "write"): Promise<void> {
		return access(path, mode === "read" ? constants.R_OK : constants.W_OK);
	}

	async mkdir(path: string, options: { recursive: boolean }): Promise<void> {
		await mkdir(path, options);
	}

	async rm(path: string, options: { recursive: boolean }): Promise<void> {
		if (options.recursive) return rm(path, { recursive: true });
		const stats = await lstat(path);
		return stats.isDirectory() ? rmdir(path) : unlink(path);
	}

	rename(from: string, to: string): Promise<void> {
		return rename(from, to);
	}

	readFile(path: string): Promise<Uint8Array> {
		return readFile(path);
	}

	writeFile(path: string, data: Uint8Array): Promise<void> {
		return writeFile(path, data);
	}
}

class NodeFile implements FsFile {
	private readonly handle: FileHandle;
	private readonly seekable: boolean;
	private readonly append: boolean;

	constructor(handle: FileHandle, seekable: boolean, append: boolean) {
		this.handle = handle;
		this.seekable = seekable;
		this.append = append;
	}

	async read(offset: number, length: number): Promise<Uint8Array> {
		const buffer = new Uint8Array(length);
		const position = this.seekable ? offset : null;
		const { bytesRead } = await this.handle.read(buffer, 0, length, position);
		return buffer.subarray(0, bytesRead);
	}

	async write(offset: number, data: Uint8Array): Promise<number> {
		const position = this.seekable && !this.append ? offset : null;
		const { bytesWritten } = await this.handle.write(data, 0, data.length, position);
		return bytesWritten;
	}

	async stat(): Promise<FsStat> {
		return toFsStat(await this.handle.stat());
	}

	close(): Promise<void> {
		return this.handle.close();
	}
}

interface FileKind {
	isDirectory(): boolean;
	isSymbolicLink(): boolean;
}

function fileType(kind: FileKind): FsFileType {
	if (kind.isDirectory()) return "dir";
	return kind.isSymbolicLink() ? "symlink" : "file";
}

function toFsStat(stats: FileKind & { size: number; mtimeMs: number; mode: number }): FsStat {
	return {
		type: fileType(stats),
		size: stats.size,
		mtimeMs: stats.mtimeMs,
		mode: stats.mode & 0o777,
	};
}

function openFlags(flags: FsOpenFlags): number {
	let result = constants.O_RDONLY;
	if (flags.write) result = flags.read ? constants.O_RDWR : constants.O_WRONLY;
	if (flags.create) result |= constants.O_CREAT;
	if (flags.truncate) result |= constants.O_TRUNC;
	if (flags.append) result |= constants.O_APPEND;
	if (flags.exclusive) result |= constants.O_EXCL;
	return result;
}
