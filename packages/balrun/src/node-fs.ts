import fs from "node:fs";
import { basename } from "node:path";

import type { FS } from "./fs";

export class NodeFS implements FS {
	open(path: string): {
		content: string;
		size: number;
		modTime: number;
		isDir: boolean;
	} | null {
		try {
			const stats = fs.statSync(path);
			if (stats.isDirectory()) {
				return {
					content: "",
					size: stats.size,
					modTime: stats.mtimeMs,
					isDir: true,
				};
			}
			const content = fs.readFileSync(path, "utf-8");
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
	stat(
		path: string,
	): { name: string; size: number; modTime: number; isDir: boolean } | null {
		try {
			const stats = fs.statSync(path);
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
	readDir(path: string): { name: string; isDir: boolean }[] | null {
		try {
			const entries = fs.readdirSync(path, { withFileTypes: true });
			return entries.map((entry) => ({
				name: entry.name,
				isDir: entry.isDirectory(),
			}));
		} catch {
			return null;
		}
	}
	writeFile(path: string, content: string): boolean {
		try {
			fs.writeFileSync(path, content, "utf-8");
			return true;
		} catch {
			return false;
		}
	}
	remove(path: string): boolean {
		try {
			fs.rmSync(path, { recursive: true, force: true });
			return true;
		} catch {
			return false;
		}
	}
	move(oldPath: string, newPath: string): boolean {
		try {
			fs.renameSync(oldPath, newPath);
			return true;
		} catch {
			return false;
		}
	}
	mkdirAll(path: string): boolean {
		try {
			fs.mkdirSync(path, { recursive: true });
			return true;
		} catch {
			return false;
		}
	}
}
