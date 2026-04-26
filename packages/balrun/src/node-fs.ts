import fs from "node:fs/promises";
import { basename } from "node:path";

import type { DirEntry, FS, OpenResult, StatResult } from "./fs";

export class NodeFS implements FS {
	async open(path: string): Promise<OpenResult | null> {
		try {
			const stats = await fs.stat(path);
			if (stats.isDirectory()) {
				return {
					content: "",
					size: stats.size,
					modTime: stats.mtimeMs,
					isDir: true,
				};
			}
			const content = await fs.readFile(path, "utf-8");
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
			const stats = await fs.stat(path);
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
			const entries = await fs.readdir(path, { withFileTypes: true });
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
			await fs.writeFile(path, content, "utf-8");
			return true;
		} catch {
			return false;
		}
	}
	async remove(path: string): Promise<boolean> {
		try {
			await fs.rm(path, { recursive: true, force: true });
			return true;
		} catch {
			return false;
		}
	}
	async move(oldPath: string, newPath: string): Promise<boolean> {
		try {
			await fs.rename(oldPath, newPath);
			return true;
		} catch {
			return false;
		}
	}
	async mkdirAll(path: string): Promise<boolean> {
		try {
			await fs.mkdir(path, { recursive: true });
			return true;
		} catch {
			return false;
		}
	}
}
