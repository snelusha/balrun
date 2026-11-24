import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";

import type { DirEntry, FS, OpenResult, StatResult } from "../core/fs";

/**
 * Node.js filesystem implementation for the Ballerina runtime.
 */
export class NodeFS implements FS {
	readonly supportsAbsolutePaths = true;

	async open(path: string): Promise<OpenResult | null> {
		try {
			const stats = await stat(path);
			if (stats.isDirectory()) {
				return {
					content: "",
					size: stats.size,
					modTime: stats.mtimeMs,
					isDir: true,
				};
			}
			const content = await readFile(path, "utf-8");
			return {
				content,
				size: stats.size,
				modTime: stats.mtimeMs,
				isDir: false,
			};
		} catch {
			return null;
		}
	}
	async stat(path: string): Promise<StatResult | null> {
		try {
			const stats = await stat(path);
			return {
				name: basename(path),
				size: stats.size,
				modTime: stats.mtimeMs,
				isDir: stats.isDirectory(),
			};
		} catch {
			return null;
		}
	}
	async readDir(path: string): Promise<DirEntry[] | null> {
		try {
			const entries = await readdir(path, { withFileTypes: true });
			return entries.map((entry) => ({
				name: entry.name,
				isDir: entry.isDirectory(),
			}));
		} catch {
			return null;
		}
	}
	async writeFile(path: string, content: string): Promise<boolean> {
		try {
			await writeFile(path, content, "utf-8");
			return true;
		} catch {
			return false;
		}
	}
	async remove(path: string): Promise<boolean> {
		try {
			await rm(path, { recursive: true, force: true });
			return true;
		} catch {
			return false;
		}
	}
	async move(oldPath: string, newPath: string): Promise<boolean> {
		try {
			await rename(oldPath, newPath);
			return true;
		} catch {
			return false;
		}
	}
	async mkdirAll(path: string): Promise<boolean> {
		try {
			await mkdir(path, { recursive: true });
			return true;
		} catch {
			return false;
		}
	}
}

function basename(path: string): string {
	const normalized = path.replace(/[/\\]+$/, "");
	const index = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
	return index === -1 ? normalized : normalized.slice(index + 1);
}
