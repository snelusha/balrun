![banner](https://raw.githubusercontent.com/snelusha/balrun/main/.github/assets/banner.png)

## Installation

```bash
npm install @snelusha/balrun
```

## CLI

```bash
npx @snelusha/balrun ./main.bal
```

Give a `.bal` file, a package directory, or `.` for the current package.

## Usage

```ts
import { Ballerina } from "@snelusha/balrun";

const ballerina = new Ballerina();

// null on success, or { error: "..." } on failure
const result = await ballerina.run("./main.bal");
```

### `colors`

By default, diagnostics are printed with ANSI colors. Pass `colors: false` to disable them.

```ts
await new Ballerina({ colors: false }).run("./main.bal");
```

The `balrun` CLI sets `colors: Boolean(process.stderr.isTTY)`, so colors are on in interactive terminals and off when stderr is piped.

### Custom `FS`

By default, `Ballerina` uses `NodeFS` to read files from disk. You can swap this out with any custom filesystem by implementing the `FS` interface and passing it in.

```ts
import { Ballerina, type FS } from "@snelusha/balrun";

class MemFS implements FS {
	// When running a single file, only `open` and `stat` are required.
	// When running a package, `readDir` is also required.
}

const fs = new MemFS({ "main.bal": `...` });
await new Ballerina({ fs }).run("main.bal");
```

See [`examples/mem-fs`](https://github.com/snelusha/balrun/tree/main/packages/balrun/examples/mem-fs) for a full `MemFS` implementation.

## Limitations

- The `FS` interface is synchronous only; asynchronous filesystems are not supported.
- Ballerina program output is always written to the process console (stdout/stderr) and cannot be redirected or configured to another sink from this API.

## Acknowledgements

Built on [ballerina-lang-go](https://github.com/ballerina-platform/ballerina-lang-go), the Ballerina platform's Go-based compiler and runtime.