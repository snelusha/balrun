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

By default, `Ballerina` uses `NodeFS` to read files from disk. You can swap this out with any custom filesystem by implementing the `FS` interface and passing it in.

### Custom `FS`

```ts
import { Ballerina, type FS } from "@snelusha/balrun";

class MemFS implements FS {
  private data = new Map<string, string>([
    ["main.bal", `import ballerina/io;\npublic function main() { io:println("hello"); }`],
  ]);

  open(path: string) {
    const text = this.data.get(path);
    return text == null ? null : { content: text, size: text.length, modTime: 0, isDir: false };
  }

  // implement remaining FS methods
}

const result = await new Ballerina({ fs: new MemFS() }).run("main.bal");
```

## Acknowledgements

Built on [ballerina-lang-go](https://github.com/ballerina-platform/ballerina-lang-go), the Ballerina platform's Go-based compiler and runtime.