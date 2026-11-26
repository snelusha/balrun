# `@snelusha/balrun` (`packages/balrun`)

README.md documents the public API. This file covers the rules and the parts that are easy to get wrong.

## Rules

- `src/core/` is universal: no `node:` imports and no DOM-only APIs. Node.js code goes in `src/node/`, browser code in `src/web/`.
- Each entry (`src/node.ts`, `src/web.ts`) builds its platform (`nodePlatform()`, `webPlatform()`) and exports `Ballerina` and `WasmBridge` bound to it. Core code receives the platform and never checks the runtime itself.
- Nothing imports `src/node.ts` or `src/web.ts`. The bundler would move an imported entry into a shared chunk, and each entry computes `new URL("./ballerina.wasm", import.meta.url)` itself, which resolves next to the chunk instead of the WASM.
- `src/react.ts` imports only from `src/core/`. `BallerinaProvider` takes a `Ballerina` instance and never chooses a platform.
- Use erasable TypeScript syntax only (no enums, namespaces or parameter properties), and `import type` for types. There are no runtime dependencies.

## Filesystem

- `src/core/fs.ts` is the contract; `packages/ballerina-wasm/bridge_fs_wasm.go` is its only caller. Change them together.
- Contents cross the boundary as `Uint8Array`, never as text. Failures are thrown with a code; `errno_wasm.go` lists the codes Go understands.
- `tests/fs.test.ts` runs the same tests against `NodeFS` and `MemFS`.

## Build (`bun run build`, `tsdown.config.ts`)

- Entries `src/node.ts`, `src/web.ts` and `src/react.ts` become `dist/node.mjs`, `dist/web.mjs` and `dist/react.mjs`. `.` resolves to `dist/node.mjs` under the `node` condition (Node.js, Bun) and to `dist/web.mjs` elsewhere.
- `packages/ballerina-wasm/dist/ballerina.wasm` is copied to `dist/ballerina.wasm`; the build fails if it is missing.

## Tests

- The HTTP listener tests bind port 6969 (`tests/fixtures/http-listener.bal`, `tests/fixtures/late-open.bal`).
