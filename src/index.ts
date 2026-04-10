import type { FS } from "./fs";
import { NodeFS } from "./node-fs";
import { getGlobalRun, loadWasm } from "./wasm-runtime";

export type { FS } from "./fs";
export { NodeFS } from "./node-fs";

export interface BallerinaOptions {
    fs?: FS;
}

export class Ballerina {
    private readonly fs: FS;

    constructor(options?: BallerinaOptions) {
        this.fs = options?.fs ?? new NodeFS();
    }

    async run(path: string): Promise<unknown> {
        if (typeof path !== "string" || path.length === 0) {
            throw new TypeError(
                "path must be a non-empty string",
            );
        }

        await loadWasm();
        return getGlobalRun()(this.fs, path);
    }
}
