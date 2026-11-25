export type MaybePromise<T> = T | Promise<T>;

export type FsFileType = "file" | "dir" | "symlink";

export interface FsStat {
	type: FsFileType;
	size: number;
	mtimeMs: number;
	/** Permission bits. Defaults to 0o644 for files and 0o755 for directories. */
	mode?: number;
}

export interface FsDirEntry {
	name: string;
	type: FsFileType;
}

export interface FsOpenFlags {
	read: boolean;
	write: boolean;
	create: boolean;
	truncate: boolean;
	/** Write at the end of the file, whatever the offset. */
	append: boolean;
	/** With `create`, fail with `EEXIST` if the path exists. */
	exclusive: boolean;
}

/**
 * An open file. Reads and writes go to the file that was opened, even if its
 * path is later renamed or removed.
 */
export interface FsFile {
	/** Reads at most `length` bytes. An empty result means end of file. */
	read(offset: number, length: number): MaybePromise<Uint8Array>;
	/**
	 * Returns the number of bytes written. Without it, the file cannot be opened
	 * for writing (`EACCES`).
	 */
	write?(offset: number, data: Uint8Array): MaybePromise<number>;
	stat?(): MaybePromise<FsStat>;
	close?(): MaybePromise<void>;
}

/**
 * Filesystem exposed to the Ballerina runtime.
 *
 * Paths are slash-separated, cleaned, and relative to the filesystem root (`.`),
 * unless `supportsAbsolutePaths` is set. Methods may be synchronous. They report
 * failures by throwing an `FsError`, or any error with a string `code` such as
 * Node.js errors; errors without a known code become `EIO`. Leaving out a method
 * that changes the filesystem makes that operation fail with `EROFS`.
 */
export interface Fs {
	/** Whether this filesystem accepts absolute paths. Defaults to false. */
	readonly supportsAbsolutePaths?: boolean;
	/** With `supportsAbsolutePaths`, the absolute directory that relative paths start from. Defaults to `/`. */
	cwd?(): MaybePromise<string>;

	stat(path: string): MaybePromise<FsStat>;
	/** Does not follow a final symbolic link. Needed only with symbolic links. */
	lstat?(path: string): MaybePromise<FsStat>;
	readdir(path: string): MaybePromise<FsDirEntry[]>;
	/** Opens a file. Directories fail with `EISDIR`, and read-only filesystems fail with `EROFS` if `flags.write` is set. */
	open(path: string, flags: FsOpenFlags): MaybePromise<FsFile>;
	/** Throws if the path cannot be accessed. Without it, access is inferred from the other methods. */
	access?(path: string, mode: "read" | "write"): MaybePromise<void>;

	/** With `recursive`, creates missing parents and accepts an existing directory. */
	mkdir?(path: string, options: { recursive: boolean }): MaybePromise<void>;
	/** Removes a file or an empty directory or, with `recursive`, a whole tree. */
	rm?(path: string, options: { recursive: boolean }): MaybePromise<void>;
	/** Replaces an existing file at `to`. */
	rename?(from: string, to: string): MaybePromise<void>;

	/** Reads a whole file. Without it, files are read through `open`. */
	readFile?(path: string): MaybePromise<Uint8Array>;
	/** Creates or replaces a whole file. Without it, files are written through `open`. */
	writeFile?(path: string, data: Uint8Array): MaybePromise<void>;
}

export class FsError extends Error {
	readonly code: string;

	constructor(code: string, message?: string) {
		super(message === undefined ? code : `${code}: ${message}`);
		this.name = "FsError";
		this.code = code;
	}
}
