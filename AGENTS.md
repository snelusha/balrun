# AGENTS.md

[`@snelusha/balrun`](https://github.com/snelusha/balrun) runs Ballerina from JavaScript/TypeScript by loading `ballerina.wasm`, which is built from the [`ballerina`](https://github.com/ballerina-nutcracker/ballerina) submodule.

## Repository structure

Workspaces are declared in the root `package.json` as `apps/*`, `examples/*`, and `packages/*`.

| Path                      | Package            | Role                                     |
| ------------------------- | ------------------ | ---------------------------------------- |
| `packages/balrun`         | `@snelusha/balrun` | TypeScript library, React hook, and CLI. |
| `packages/ballerina-wasm` | `ballerina-wasm`   | Builds `ballerina.wasm` with Go.         |
| `examples/memfs`          | `example-memfs`    | In-memory filesystem usage example.      |
| `examples/vite`           | `example-vite`     | Vite + React browser usage example.      |

`packages/ballerina-wasm/ballerina` is an upstream submodule and has its own `AGENTS.md`.

## Commands

Use **Bun** for installs and scripts. Do **not** use npm, pnpm, or yarn.

Useful root scripts:

- `bun install --frozen-lockfile`
- `bun run build` — Turbo build across workspaces
- `bun run test` — Turbo test across workspaces
- `bun run lint` / `bun run lint:fix` — Oxlint (and safe auto-fixes)
- `bun run format` / `bun run format:check` — Oxfmt (write / verify formatting)

## Conventions

- Oxlint and Oxfmt are the primary linter and formatter; keep tab indentation and double quotes.
- Avoid editing generated `dist/` files unless explicitly required.

## Tests

Ballerina programs are tested through the corpus in `packages/balrun/tests/corpus`, not as sources inside TypeScript. Tests run with `bun run test`, with `bun run test:node` under Node.js, and with `bun run test:browser` in Chromium (run `bunx playwright install chromium-headless-shell` once).

- `bal/<path>-{v,e,p}.bal` is a case; a directory with the same suffix is a project. `-v` runs cleanly, `-e` fails to compile, `-p` panics.
- `integration/<path>.txtar` is its golden, with `stdout`, `stderr`, and `exitcode` sections. Generate goldens with `bun run --filter @snelusha/balrun test:update` and review the diff.
- Mark each printed line with `// @output <text>`. Markers are checked in update mode too.
- Add `// @requires ipv6` when a case needs it. Cases under `bal/browser/` run without host sockets, and those plus `core/` and `project/` also run in Chromium.
- Cases under `bal/hosted/` need something outside Ballerina, such as a server or an external peer, and each needs a driver in `tests/harness/drivers.ts`.
- Corpus programs use fixed ports from `19600` to `19999`, and each port belongs to one case.

## Task completion

Before considering work complete, `bun run lint` and `bun run test` should pass at the repository root.
