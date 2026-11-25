import type { FS } from "./fs";
import type { HTTPServerFactory } from "./http-listener";
import type { Environment, OSPlatform } from "./os";

export interface Platform {
	readonly wasm: URL;
	readWasm?(source: string | URL): Promise<Uint8Array> | undefined;
	defaultFS?(): FS;
	createOS(environment?: Environment): OSPlatform;
	httpServer?: HTTPServerFactory;
}
