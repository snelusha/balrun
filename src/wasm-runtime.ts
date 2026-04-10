import "./wasm_exec";

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import type { FS } from "./fs";

/** wasm_exec attaches `Go` to globalThis at runtime */
interface WasmGoCtor {
    new (): {
        importObject: Record<string, WebAssembly.ModuleImports>;
        run(instance: WebAssembly.Instance): void;
    };
}

let ready: Promise<void> | null = null;

const filename = fileURLToPath(import.meta.url);
const dirnamePath = dirname(filename);

/** Go wasm registers `run` on globalThis after WASM load */
export function getGlobalRun(): (fs: FS, path: string) => unknown {
    const fn = (globalThis as unknown as { run?: unknown }).run;
    if (typeof fn !== "function") {
        throw new Error(
            "balrun: globalThis.run is missing; WASM may not have initialized",
        );
    }
    return fn as (fs: FS, path: string) => unknown;
}

async function initializeWasm(): Promise<void> {
    const Go = (globalThis as unknown as { Go: WasmGoCtor }).Go;
    const go = new Go();
    const wasmPath = join(dirnamePath, "ballerina.wasm");
    const wasmBuffer = readFileSync(wasmPath);
    const { instance } = await WebAssembly.instantiate(
        wasmBuffer,
        go.importObject,
    );
    go.run(instance);
    await new Promise<void>((resolve) => setImmediate(resolve));
}

export function loadWasm(): Promise<void> {
    ready ??= initializeWasm().catch((error) => {
        ready = null;
        throw error;
    });

    return ready;
}
