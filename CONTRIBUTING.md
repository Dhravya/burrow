# Contributing to Burrow

Thanks for helping out. Be kind — that's the whole code of conduct.

## Prerequisites

- [Bun](https://bun.sh) >= 1.3 (Burrow is built with Bun and uses Bun-only APIs like `Bun.serve` and HTML imports — Node.js won't work)
- A browser for manual testing (some features, like the local AI panel, need WebGPU)

## Setup

```sh
bun install
bun run dev     # starts the dev server (server.ts) with HMR
```

## Running tests

```sh
bun test
```

Use `bun test <path>` to run a single file. Tests use `bun:test` (`import { test, expect } from "bun:test"`) — not jest or vitest.

## Module ownership (read CONTRACT.md)

The codebase is split into modules under `src/` (`vfs`, `git`, `toolchain`, `ai`, `shell`, `ui`, `npm`), each with a fixed init entrypoint wired up in boot order by `src/ui/main.tsx`. The rule from [CONTRACT.md](./CONTRACT.md):

**Runtime access to another module goes only through the contract layer** — types from `src/contract/types.ts` and the service locator in `src/contract/registry.ts` (`provide` / `use` / `tryUse`, `registerShellCommand`). Do not import another module's files directly. The sanctioned exceptions are:

1. `src/ui/main.tsx` imports each module's init entrypoint (`initVfs`, `initGit`, ...).
2. `server.ts` imports `handleGitProxy` from `src/git/proxy.ts` (the server side has no registry).
3. Anyone may import npm packages and `src/contract/*`.

If you need something a module doesn't expose, extend the contract types and the providing module — don't reach into its internals.

## Where things go

- **Shell commands**: define a `CommandSpec` and call `registerShellCommand(spec)` from your module's init function (see `src/git/` and `src/toolchain/commands.ts` for examples). Registration must happen during init — the shell seals the command set at boot. Honor `ctx.signal` for long-running work and decode `ctx.stdin` with `decodeStdin()` before treating it as text (CONTRACT.md §4).
- **Node builtin shims** (what `import "node:path"` etc. resolves to inside run workers): `src/toolchain/node-builtins.ts`.
- **Bun API shims** (the `Bun` global available to sandboxed code, e.g. `Bun.serve`): the generated worker bootstrap in `src/toolchain/bootstrap.ts`.
- **npm resolution / install behavior**: `src/npm/`.
- **Filesystem and events**: `src/vfs/` — every write goes through the shared `WatchedFs` so the UI, git, and shell stay in sync.

## Pull requests

- Keep `bun test` green — all tests must pass before a PR is merged.
- `bunx tsc --noEmit` should also stay clean.
- New behavior should come with tests where the logic is testable outside the DOM (see existing `*.test.ts` files for patterns).
- Small, focused PRs are easier to review than large ones.
