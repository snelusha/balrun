import type { DirEntry, FS, OpenResult, StatResult } from "./core";

const NODE_FS_PROMISES_MODULE = "node:fs/promises";

/**
 * Node.js filesystem implementation for the Ballerina runtime.
 */
export class NodeFS implements FS {
	async open(path: string): Promise<OpenResult | null> {
		try {
			const fs = await nodeFs();
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
			const fs = await nodeFs();
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
			const fs = await nodeFs();
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
			const fs = await nodeFs();
			await fs.writeFile(path, content, "utf-8");
			return true;
		} catch {
			return false;
		}
	}
	async remove(path: string): Promise<boolean> {
		try {
			const fs = await nodeFs();
			await fs.rm(path, { recursive: true, force: true });
			return true;
		} catch {
			return false;
		}
	}
	async move(oldPath: string, newPath: string): Promise<boolean> {
		try {
			const fs = await nodeFs();
			await fs.rename(oldPath, newPath);
			return true;
		} catch {
			return false;
		}
	}
	async mkdirAll(path: string): Promise<boolean> {
		try {
			const fs = await nodeFs();
			await fs.mkdir(path, { recursive: true });
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

let nodeFsPromise: Promise<typeof import("node:fs/promises")> | undefined;

async function nodeFs(): Promise<typeof import("node:fs/promises")> {
	nodeFsPromise ??= import(/* @vite-ignore */ NODE_FS_PROMISES_MODULE);
	return nodeFsPromise;
}
