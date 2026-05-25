![banner](https://raw.githubusercontent.com/snelusha/balrun/main/.github/assets/banner.png)

## Installation

```bash
npm install @snelusha/balrun
```

## CLI

```bash
npx @snelusha/balrun ./main.bal
```

Accepts a `.bal` file, a package directory, or `.` for the current package.

## Usage

```ts
import { Ballerina } from "@snelusha/balrun";

const ballerina = new Ballerina({ colors: false });

// Returns null on success, or { error: "..." } on failure
const result = await ballerina.run("./main.bal", { colors: true });
```

Options passed to `run()` override the constructor defaults for that call only.

## React

```tsx
import { useBallerina } from "@snelusha/balrun/react";

function RunButton() {
  const { isReady, error, run } = useBallerina({
    fs: new SomeFS(), // Required in browser environments
  });

  return (
    <button disabled={!isReady} onClick={() => run("./main.bal")}>
      {error ? error.message : "Run Ballerina"}
    </button>
  );
}
```

`useBallerina()` accepts the same options as `Ballerina` and initializes the runtime.

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

See [`examples/mem-fs`](https://github.com/snelusha/balrun/tree/main/packages/balrun/examples/mem-fs) for a full implementation.

### `wasmUrl` / `core`

By default, `Ballerina` loads the bundled `ballerina.wasm`. Pass `wasmUrl` to load a different local path or HTTP(S) URL:

```ts
await new Ballerina({ wasmUrl: "https://example.com/ballerina.wasm" }).run(
  "main.bal",
);
```

For custom loading, pass a `BallerinaCore` directly. `WasmBridge.load()` accepts a local path, URL, `Response`, or `Promise<Response>`:

```ts
import { Ballerina, WasmBridge } from "@snelusha/balrun";

const core = await WasmBridge.load(fetch("/ballerina.wasm"));
await new Ballerina({ core }).run("main.bal");
```

## Acknowledgements

Built on [ballerina-lang-go](https://github.com/ballerina-platform/ballerina-lang-go).
