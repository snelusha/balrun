# MemFS Example

Minimal Bun example running [Ballerina](https://ballerina.io/) with an in-memory virtual file system and [`@snelusha/balrun`](https://www.npmjs.com/package/@snelusha/balrun).

## Setup

From the monorepo root:

```bash
bun install
bun run examples/memfs
```

## How It Works

- `@snelusha/balrun` creates a Ballerina runtime directly from TypeScript
- `MemFS` implements the virtual file system interface required by the runtime
- `main.bal` is stored in memory and executed without touching the real file system
