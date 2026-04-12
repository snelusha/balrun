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

## Acknowledgements

Built on [ballerina-lang-go](https://github.com/ballerina-platform/ballerina-lang-go), the Ballerina platform's Go-based compiler and runtime.