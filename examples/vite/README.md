# Vite Example

Minimal Vite + React example running [Ballerina](https://ballerina.io/) in the browser with [`@snelusha/balrun`](https://www.npmjs.com/package/@snelusha/balrun).

## Setup

From the monorepo root:

```bash
bun install
bun -F example-vite dev
```

## How It Works

- `@snelusha/balrun/react` initializes the Ballerina runtime with `useBallerina`
- A small virtual file system provides `main.bal` from the editor contents
- `stdout` and `stderr` are written into the output textarea
- The virtual file system is kept stable so editing code does not reinitialize the runtime
