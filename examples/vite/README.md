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
- `OPFS` stores `main.bal` in the browser, so the editor contents persist across reloads
- `stdout` and `stderr` are written into the output textarea
- The filesystem is created once, so editing code does not reinitialize the runtime
