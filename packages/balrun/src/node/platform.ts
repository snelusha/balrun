import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { NodeFS } from "./fs";
import { nodeHTTPServer } from "./http-server";
import { NodeOSPlatform } from "./os";

import type { Platform } from "../core/platform";

export function nodePlatform(wasm: URL): Platform {
	return {
		wasm,
		readWasm(source) {
			const path = localPath(source);
			if (path === undefined) return undefined;
			return readFile(path).then((b) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
		},
		defaultFS: () => new NodeFS(),
		createOS: () => new NodeOSPlatform(),
		httpServer: nodeHTTPServer,
	};
}

function localPath(source: string | URL): string | undefined {
	if (source instanceof URL) return source.protocol === "file:" ? fileURLToPath(source) : undefined;
	if (source.startsWith("file:")) return fileURLToPath(source);
	return /^[a-z][a-z0-9+.-]+:/i.test(source) ? undefined : source;
}
