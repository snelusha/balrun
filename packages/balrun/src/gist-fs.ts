import type { FS } from "./fs";

export interface GistFSOptions {
	/** Gist id or a gist URL (`https://gist.github.com/user/abc123…`). */
	gistIdOrUrl: string;
	/** Optional GitHub PAT (`gist` scope) for private gists and higher rate limits. */
	token?: string;
}

interface GistFileJson {
	filename: string;
	size?: number;
	truncated?: boolean;
	content?: string;
	raw_url?: string;
}

interface GistResponseJson {
	updated_at?: string;
	files?: Record<string, GistFileJson>;
}

function parseGistId(input: string): string {
	const trimmed = input.trim().replace(/\/+$/, "");
	const fromUrl = trimmed.match(
		/gist\.github\.com\/(?:[^/]+\/)?([a-f0-9]{7,}|[0-9a-f]{32})/i,
	);
	const id = fromUrl?.[1];
	if (id) return id;
	if (/^[a-f0-9]{7,}$/i.test(trimmed)) return trimmed;
	throw new Error(`Invalid gist id or URL: ${input}`);
}

function normalizePath(path: string): string {
	const p = path.replace(/^\/+/, "").replace(/\/+$/, "");
	if (p === "." || p === "") return "";
	if (p.includes("/")) return p;
	return p;
}

function isRoot(path: string): boolean {
	const n = normalizePath(path);
	return n === "";
}

function githubHeaders(token?: string): Record<string, string> {
	const h: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
	};
	if (token) h.Authorization = `Bearer ${token}`;
	return h;
}

function updatedAtToMs(updatedAt?: string): number {
	if (!updatedAt) return Date.now();
	const t = Date.parse(updatedAt);
	return Number.isNaN(t) ? Date.now() : t;
}

async function fetchFileContent(
	file: GistFileJson,
	headers: Record<string, string>,
): Promise<string> {
	if (!file.truncated && file.content != null) return file.content;
	if (!file.raw_url) return "";
	const res = await fetch(file.raw_url, { headers });
	if (!res.ok) return "";
	return res.text();
}

/**
 * {@link FS} backed by a single GitHub Gist (flat filenames only; no subfolders).
 *
 * Because the GitHub API is asynchronous, call {@link GistFS.load} to fetch
 * the gist, then use the synchronous {@link FS} methods against an in-memory
 * copy. Call {@link GistFS.push} to write changes back with a gist PATCH.
 */
export class GistFS implements FS {
	private modTimeMs: number;
	private readonly remoteNames = new Set<string>();
	private readonly files = new Map<string, string>();

	private constructor(
		private readonly gistId: string,
		private readonly token: string | undefined,
		updatedAt: string | undefined,
	) {
		this.modTimeMs = updatedAtToMs(updatedAt);
	}

	static async load(options: GistFSOptions): Promise<GistFS> {
		const gistId = parseGistId(options.gistIdOrUrl);
		const headers = githubHeaders(options.token);
		const url = `https://api.github.com/gists/${gistId}`;
		const res = await fetch(url, { headers });
		if (!res.ok) {
			throw new Error(
				`GistFS.load: ${res.status} ${res.statusText} for ${url}`,
			);
		}
		const body = (await res.json()) as GistResponseJson;
		const instance = new GistFS(gistId, options.token, body.updated_at);
		const fileEntries = Object.values(body.files ?? {});
		for (const f of fileEntries) {
			const name = f.filename;
			if (!name) continue;
			const content = await fetchFileContent(f, headers);
			instance.files.set(name, content);
			instance.remoteNames.add(name);
		}
		return instance;
	}

	/** Persist in-memory files to GitHub (creates, updates, and deletes as needed). */
	async push(): Promise<boolean> {
		const url = `https://api.github.com/gists/${this.gistId}`;
		const files: Record<string, { content: string } | null> = {};

		for (const name of this.remoteNames) {
			if (!this.files.has(name)) files[name] = null;
		}
		for (const [name, content] of this.files) {
			files[name] = { content };
		}

		const patchHeaders = new Headers(githubHeaders(this.token));
		patchHeaders.set("Content-Type", "application/json");
		const res = await fetch(url, {
			method: "PATCH",
			headers: patchHeaders,
			body: JSON.stringify({ files }),
		});
		if (!res.ok) return false;
		const body = (await res.json()) as GistResponseJson;
		this.modTimeMs = updatedAtToMs(body.updated_at);
		this.remoteNames.clear();
		for (const name of this.files.keys()) this.remoteNames.add(name);
		return true;
	}

	open(path: string): {
		content: string;
		size: number;
		modTime: number;
		isDir: boolean;
	} | null {
		if (isRoot(path)) {
			return {
				content: "",
				size: 0,
				modTime: this.modTimeMs,
				isDir: true,
			};
		}
		const name = normalizePath(path);
		const content = this.files.get(name);
		if (content === undefined) return null;
		return {
			content,
			size: Buffer.byteLength(content, "utf-8"),
			modTime: this.modTimeMs,
			isDir: false,
		};
	}

	stat(
		path: string,
	): { name: string; size: number; modTime: number; isDir: boolean } | null {
		if (isRoot(path)) {
			return {
				name: ".",
				size: 0,
				modTime: this.modTimeMs,
				isDir: true,
			};
		}
		const name = normalizePath(path);
		const content = this.files.get(name);
		if (content === undefined) return null;
		return {
			name,
			size: Buffer.byteLength(content, "utf-8"),
			modTime: this.modTimeMs,
			isDir: false,
		};
	}

	readDir(path: string): { name: string; isDir: boolean }[] | null {
		if (!isRoot(path)) return null;
		return [...this.files.keys()]
			.sort()
			.map((name) => ({ name, isDir: false }));
	}

	writeFile(path: string, content: string): boolean {
		const name = normalizePath(path);
		if (name === "" || name.includes("/")) return false;
		this.files.set(name, content);
		this.modTimeMs = Date.now();
		return true;
	}

	remove(path: string): boolean {
		if (isRoot(path)) return false;
		const name = normalizePath(path);
		if (name.includes("/")) return false;
		return this.files.delete(name);
	}

	move(oldPath: string, newPath: string): boolean {
		const from = normalizePath(oldPath);
		const to = normalizePath(newPath);
		if (from === "" || to === "" || from.includes("/") || to.includes("/"))
			return false;
		const content = this.files.get(from);
		if (content === undefined) return false;
		if (this.files.has(to)) return false;
		this.files.delete(from);
		this.files.set(to, content);
		this.modTimeMs = Date.now();
		return true;
	}

	mkdirAll(path: string): boolean {
		return isRoot(path);
	}
}
