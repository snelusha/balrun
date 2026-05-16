import type {
	BallerinaCore,
	BallerinaRunOptions,
	BallerinaRunResult,
} from "./ballerina-core";
import type { FS } from "./fs";

export class WasmBridge implements BallerinaCore {
	static async load(
		source: string | Response | PromiseLike<Response>,
	): Promise<WasmBridge> {
		await import("./wasm_exec");
		const go = new Go();
		const instance = await loadWasm(source, go.importObject);
		go.run(instance);
		await new Promise((resolve) => setImmediate(resolve));
		return new WasmBridge();
	}

	run(
		proxy: FS,
		path: string,
		options?: BallerinaRunOptions,
	): Promise<BallerinaRunResult> {
		return globalThis.run(proxy, path, options);
	}
}

function loadWasm(
	source: string | Response | PromiseLike<Response>,
	importObject: WebAssembly.Imports,
): Promise<WebAssembly.Instance> {
	if (typeof source === "string") {
		if (isRemoteUrl(source)) return loadRemote(source, importObject);
		else return loadLocal(source, importObject);
	} else {
		return loadFromResponse(source, importObject);
	}
}

async function loadRemote(
	url: string,
	importObject: WebAssembly.Imports,
): Promise<WebAssembly.Instance> {
	const { instance } = await WebAssembly.instantiateStreaming(
		fetch(url),
		importObject,
	);
	return instance;
}

async function loadLocal(
	path: string,
	importObject: WebAssembly.Imports,
): Promise<WebAssembly.Instance> {
	const fs = await import("node:fs/promises");
	const buffer = await fs.readFile(toLocalPath(path));
	const { instance } = await WebAssembly.instantiate(buffer, importObject);
	return instance;
}

async function loadFromResponse(
	response: Response | PromiseLike<Response>,
	importObject: WebAssembly.Imports,
): Promise<WebAssembly.Instance> {
	const { instance } = await WebAssembly.instantiateStreaming(
		response instanceof Response ? Promise.resolve(response) : response,
		importObject,
	);
	return instance;
}

function isRemoteUrl(source: string): boolean {
	try {
		const url = new URL(source);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

function toLocalPath(path: string): string | URL {
	try {
		const url = new URL(path);
		return url.protocol === "file:" ? url : path;
	} catch {
		return path;
	}
}
