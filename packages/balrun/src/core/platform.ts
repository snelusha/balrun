import type { Fs } from "./fs";
import type { HTTPServerFactory } from "./http-listener";
import type { Environment, OSPlatform } from "./os";

export interface Platform {
	readonly wasm: URL;
	readWasm?(source: string | URL): Promise<Uint8Array> | undefined;
	defaultFS?(): Fs;
	createOS(environment?: Environment): OSPlatform;
	httpServer?: HTTPServerFactory;
}
