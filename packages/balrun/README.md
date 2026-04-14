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
const writer: StreamWriter = { write(chunk) { buffer.push(chunk); } };

await new Ballerina({ stdout: writer, stderr: writer }).run("./main.bal");
```

### `fs`

By default, `Ballerina` reads from disk via `NodeFS`. Swap it out by implementing the `FS` interface — useful for in-memory or virtual filesystems.

```ts
import { Ballerina, type FS } from "@snelusha/balrun";

class MemFS implements FS {
  // When running a single file, only `open` and `stat` are required.
  // When running a package, `readDir` is also required.
}

await new Ballerina({ fs: new MemFS() }).run("main.bal");
```

See [`examples/mem-fs`](https://github.com/snelusha/balrun/tree/main/packages/balrun/examples/mem-fs) for a full implementation.

## Limitations

- The `FS` interface is synchronous only.

## Acknowledgements

Built on [ballerina-lang-go](https://github.com/ballerina-platform/ballerina-lang-go).
