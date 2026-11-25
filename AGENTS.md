# AGENTS.md

[`@snelusha/balrun`](https://github.com/snelusha/balrun) runs Ballerina from JavaScript/TypeScript by loading `ballerina.wasm`, which is built from the [`ballerina`](https://github.com/ballerina-nutcracker/ballerina) interpreter (a Go module dependency pinned in `packages/ballerina-wasm/go.mod`).

## Repository structure

Workspaces are declared in the root `package.json` as `apps/*`, `examples/*`, and `packages/*`.

| Path                      | Package            | Role                                     |
| ------------------------- | ------------------ | ---------------------------------------- |
| `packages/balrun`         | `@snelusha/balrun` | TypeScript library, React hook, and CLI. |
| `packages/ballerina-wasm` | `ballerina-wasm`   | Builds `ballerina.wasm` with Go.         |
| `examples/vite`           | `example-vite`     | Vite + React browser usage example.      |

## Commands

Use **Bun** for installs and scripts. Do **not** use npm, pnpm, or yarn.

Useful root scripts:

- `bun install --frozen-lockfile`
- `bun run build` — Turbo build across workspaces
- `bun run test` — Turbo test across workspaces
- `bun run lint` / `bun run lint:fix` — Oxlint (and safe auto-fixes)
- `bun run format` / `bun run format:check` — Oxfmt (write / verify formatting)

## Areas

`.agents/` has one file per area. Read the one for the area you change:

| File                                   | Covers                                                                |
| -------------------------------------- | --------------------------------------------------------------------- |
| [.agents/balrun.md](.agents/balrun.md) | `packages/balrun`: the core/node/web split, entry rules, build, tests |

## Conventions

- Oxlint and Oxfmt are the primary linter and formatter; keep tab indentation and double quotes.
- Avoid editing generated `dist/` files unless explicitly required.

## Task completion

Before considering work complete, `bun run lint` and `bun run test` should pass at the repository root.
