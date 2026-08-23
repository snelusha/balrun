![banner](https://raw.githubusercontent.com/snelusha/balrun/main/.github/assets/banner.png)

> [!WARNING]
> This project is actively evolving, and APIs may change frequently.

## Installation

```bash
npm install @snelusha/balrun
```

## CLI

```bash
npx @snelusha/balrun ./main.bal
```

Accepts a `.bal` file, a package directory, or `.` for the current package.

Use `balrun --version` for the balrun package version and `balrun --interpreter-version` for JSON containing the embedded interpreter release tag and commit.

## Usage

```ts
import { Ballerina } from "@snelusha/balrun";

const ballerina = new Ballerina({ colors: false });
const exitCode = await ballerina.run("./main.bal", { colors: true });
```

Options passed to `run()` override the constructor defaults for that call only.

### Interpreter version

`getInterpreterVersion()` identifies the interpreter compiled into the loaded WASM binary. This also reflects a custom `wasmSource` or `core`.

```ts
const interpreter = await ballerina.getInterpreterVersion();
// { version: "v0.6.0", commit: "c5ce6e641c21d9ad2f438e42c90042d7fc39b392" }
```

`version` is `null` for an untagged interpreter build; `commit` is always its full source commit SHA.

## Stopping a run

Use `stop()` to stop a running Ballerina program. The default mode is graceful; pass `"immediate"` to stop immediately.

```ts
const running = ballerina.run("./service.bal");

await ballerina.stop();
const exitCode = await running;
```

The CLI forwards `SIGINT` and `SIGTERM` as graceful stops, and `SIGQUIT` as an immediate stop.

## React

```tsx
import { BallerinaProvider, useBallerina } from "@snelusha/balrun/react";

const fs = new SomeFS();

function App() {
  return (
    <BallerinaProvider fs={fs}>
      <RunButton />
    </BallerinaProvider>
  );
}

function RunButton() {
  const { isReady, error, run } = useBallerina();

  return (
    <button disabled={!isReady} onClick={() => run("./main.bal")}>
      {error ? error.message : "Run Ballerina"}
    </button>
  );
}
```

`BallerinaProvider` accepts the same options as `Ballerina` and initializes one shared runtime for its descendants. `useBallerina()` must be called within a provider. In browser environments, provide an `fs` implementation.

See [`examples/vite`](https://github.com/snelusha/balrun/tree/main/examples/vite) for a Vite + React browser example.

## Options

### `colors`

Diagnostics use ANSI colors by default. Pass `colors: false` to disable. The CLI auto-detects based on `stderr.isTTY`.

### `stdout` / `stderr`

Redirect runtime output by passing any object that implements `StreamWriter`:

```ts
import type { StreamWriter } from "@snelusha/balrun";

const writer: StreamWriter = { write(chunk: string) {} };
```

Example:

```ts
import { Ballerina, type StreamWriter } from "@snelusha/balrun";

const buffer: string[] = [];
const writer: StreamWriter = {
  write(chunk) {
    buffer.push(chunk);
  },
};

await new Ballerina({ stdout: writer, stderr: writer }).run("./main.bal");
```

### `fs`

`Ballerina` reads files through the `FS` interface. In Node.js environments, this defaults to the built-in Node adapter. In browsers, pass an `fs` implementation explicitly.

```ts
import { Ballerina, type FS } from "@snelusha/balrun";

class MemFS implements FS {
  // When running a single file, only `open` and `stat` are required.
  // When running a package, `readDir` is also required.
}

await new Ballerina({ fs: new MemFS() }).run("main.bal");
```

To use the Node adapter explicitly:

```ts
import { Ballerina } from "@snelusha/balrun";
import { NodeFS } from "@snelusha/balrun/fs/node";

await new Ballerina({ fs: new NodeFS() }).run("./main.bal");
```

See [`examples/memfs`](https://github.com/snelusha/balrun/tree/main/examples/memfs) for a full implementation.

### `env`

In browsers, Ballerina's environment-variable operations use a copy of the supplied map for each run. User and home-directory lookups and subprocess execution are unavailable in browsers and panic when called. Node.js and Bun use the host environment and support all OS operations, including `os:exec`.

```ts
import { Ballerina } from "@snelusha/balrun";
import { NodeFS } from "@snelusha/balrun/fs/node";

const env = new Map([["GREETING", "hello"]]);
await new Ballerina({ fs: new NodeFS(), env }).run("main.bal");
```

### HTTP services

Node.js and Bun bind Ballerina HTTP listeners to a local socket. Browsers cannot bind sockets; use `dispatchHttpRequest` to forward requests to the running service instead. `onListenerReady` provides the listener address in either environment.

```ts
const running = ballerina.run("service.bal", {
  onListenerReady: async ({ host, port }) => {
    const response = await ballerina.dispatchHttpRequest({ host, port, path: "/ping" });
    console.log(new TextDecoder().decode(response.body));
    await ballerina.stop();
  },
});
await running;
```

### `wasmSource` / `core`

By default, `Ballerina` loads the bundled `ballerina.wasm`. Pass `wasmSource` to load a different local path or HTTP(S) URL:

```ts
await new Ballerina({ wasmSource: "https://example.com/ballerina.wasm" }).run("main.bal");
```

For custom loading, pass a `BallerinaCore` directly. `WasmBridge.load()` accepts a local path, URL, `Response`, or `Promise<Response>`:

```ts
import { Ballerina, WasmBridge } from "@snelusha/balrun";

const core = await WasmBridge.load(fetch("/ballerina.wasm"));
await new Ballerina({ core }).run("main.bal");
```

### Bundler note

`ballerina.wasm` must be available in the final build output at runtime.

Vite handles this automatically: it detects the default WASM URL and emits `ballerina.wasm` into `dist/assets` during `vite build`. Other bundlers may not copy the file automatically. If your built app cannot find `ballerina.wasm`, copy it from `node_modules/@snelusha/balrun/dist/ballerina.wasm` into your app's output directory, or use `wasmSource` to point to where you serve it.

## Acknowledgements

Built on [ballerina](https://github.com/ballerina-nutcracker/ballerina).
