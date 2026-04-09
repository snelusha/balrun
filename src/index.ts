import "./wasm_exec";

import { readFileSync } from "fs";
import { join } from "path";
import { NodeFS } from "./node-fs";

let _ready: Promise<void> | null = null;

async function initializeWasm(): Promise<void> {
    const go = new globalThis.Go();
    const wasmPath = join(__dirname, "ballerina.wasm");
    const wasmBuffer = readFileSync(wasmPath);
    const { instance } = await WebAssembly.instantiate(
        wasmBuffer,
        go.importObject,
    );
    go.run(instance);
    await new Promise<void>((resolve) => setImmediate(resolve));
}

function loadWasm(): Promise<void> {
    _ready ??= initializeWasm().catch((err) => {
        _ready = null;
        throw err;
    });

    return _ready;
}

export async function run(path: string) {
    await loadWasm();
    const fs = new NodeFS();
    return globalThis.run(fs, path);
}
