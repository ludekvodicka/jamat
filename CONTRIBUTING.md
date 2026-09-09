# Contributing to Jamat

Thanks for looking. Bug reports, ideas and pull requests are all welcome. Please keep it friendly:
see the [Code of Conduct](CODE_OF_CONDUCT.md).

This file is also the map. The repository ships no design documents, so what follows is the
orientation: how the tree is laid out, what each package is responsible for, how to run it, and what
has to be green before a change lands.

## Ways to help

- **Report a bug** with the steps, your OS and the version on the status bar.
- **Suggest a feature** by describing the problem first and the shape of the fix second.
- **Send a pull request.** For anything beyond a small fix, open an issue and agree the approach
  first, so neither of us spends a weekend on something that will not merge.
- **Never open a public issue for a security problem.** See [SECURITY.md](SECURITY.md).

## How your changes land

Jamat is developed in a separate primary working tree and this repository is published from it as a
squashed sync. Pull requests are very welcome; a merged one is carried back into that tree by hand
and reappears here inside a later sync commit, so it may be squashed or re-authored rather than
preserved commit for commit. None of that changes how you contribute.

## The shape of the tree

Five packages, each with its own `pnpm-lock.yaml` and its own `node_modules`. The split is by
process, not by layer: a directory exists because something owns state that outlives its caller.

| Package | What it is |
| --- | --- |
| `app-host` | The process that owns the terminals. It survives every client closing. Create, inspect, attach, input, resize, stop and remove over a token-guarded loopback HTTP and WebSocket API. It is agent-agnostic: it spawns exactly the command, environment and size it is handed, and knows nothing about Claude or Codex. Nothing it imports comes from outside the package. |
| `lib-orchestrator` | The library both clients link, and the whole seam between a client and the Host. It owns projects, provider session history, durable session records, launching and reconciliation, work state, file changes and diffs, file viewing, the rate, model and transcript readers, worktrees and merges, project setup, Host control, and the transport-independent remote-control contract. It owns no process. |
| `app-client-ui` | The Electron client: the workspace window, extra windows, the native menu, status bar, sessions tree, launcher, settings, dockview tabs and live terminal panels, plus a Debug window. It reaches the Host only through `lib-orchestrator`, and it hosts the authenticated loopback control endpoint. |
| `app-client-cli` | A short-lived JSON client for that control endpoint, and for the paired computers behind it. It owns no durable state. |
| `mdext-renderer` | The renderer for the enriched Markdown the file viewer draws. Sources only; the client compiles it. |

Around them: `scripts/` (one directory per role: `smoke/`, `checks/`, `release/`, `setup/`, `dev/`),
`configs/` (the example configuration, the reMarkable sidecar recipe, the file-viewer testbed),
`skills/` (the agent skill adapters the client links into your Claude and Codex skill directories).

Inside a package the same two rules hold everywhere:

- **`start.ts` at the package root is the executable; `app/app.ts` is the application class.** The
  two never merge, because a module-scope `run()` beside the class would boot the application
  whenever anything imported it.
- **A directory is named after the subsystem it is, never after a tier.** In `lib-orchestrator`
  that means `sessionManager/`, `fileChangesManager/`, `remoteControl/` and so on, each with its
  public surface at its root and its internals in subdirectories. There is no shared `core/`;
  `shared/` at any level means "shared among the things standing beside it", and it earns its place
  only once a second consumer exists.

## Development setup

**Prerequisites:** Node.js 22.16 or newer, [pnpm](https://pnpm.io) (the version is pinned in
`packageManager`, so `corepack enable` is enough), and at least one of
[Claude Code](https://www.anthropic.com/claude-code) or Codex on your `PATH`. Windows is the
platform the project is developed and released on; macOS and Linux builds exist and are less
travelled.

All five installs are required. `pnpm typecheck` compiles every package, and the smoke suite spawns
a real Host, which needs `node-pty` from the Host's own `node_modules`.

```bash
git clone https://github.com/ludekvodicka/jamat && cd jamat

pnpm install
pnpm -C app-host install
pnpm -C lib-orchestrator install
pnpm -C app-client-ui install
pnpm -C app-client-cli install
```

Run a surface:

```bash
pnpm run ui                                                 # the client, electron-vite dev
pnpm run host -- --config-dir <dir> --channel development   # a Host on its own
pnpm run jamat-v3 -- status                                 # the CLI against a running client
```

The client starts its own Host when it cannot find one, so `pnpm run ui` on its own is the usual
loop; run `pnpm run host` separately when you want to watch the Host's output or restart the client
against a Host that keeps running.

State lives in one config directory, `~/.jamat-v3` by default. `--config-dir` overrides it, and so
does `JAMAT_V3_CONFIG_DIR`. **Every environment variable this project reads is named `JAMAT_V3_*`.**
That is deliberate and worth keeping: an unprefixed name is another generation's, and a terminal
opened inside one of those exports it.

## What has to be green

```bash
pnpm typecheck   # five TypeScript programs, plus the check that the two skill adapters are identical
pnpm test        # the unit suites of every package: a fake terminal, a fake Host, jsdom for the web side
```

Both have to pass. Beyond them are the smokes, which run the real thing against real files, a real
PTY and a real Host; they are not part of `pnpm test` because they spawn processes and take time.
Run the ones your change touches:

```bash
pnpm smoke:host                # the Host end to end against a real PTY
pnpm smoke:session-manager     # the session chain against a real Host
pnpm smoke:project-manager     # the project chain over real files
pnpm smoke:file-changes        # diffs against real working copies
pnpm smoke:remote-control      # CLI to client to Host, with a real PTY at the end
pnpm smoke:remote-app          # one client driving another
pnpm smoke:ui                  # builds and boots a real window
```

`pnpm run` with no arguments lists the rest.

Tests sit beside the code they test, and the suffix picks the runner: `<name>.test.ts` is a unit
test. The root `describe()` follows the file's path, so a failure names where it lives.

## Code style

Match the file you are editing. The rules that are not obvious from reading one:

- **TypeScript everywhere, ESM, relative imports.** No path aliases, and no barrel files: import the
  concrete file rather than an `index.ts` that re-exports it.
- **A file with a class identity has no top-level `const` or `function`.** Constants live on the
  class as `<name>Const`, helpers as private statics. Types, interfaces and error classes are the
  exception, as are the exports a framework demands.
- **Branch exhaustively on a fixed set of values.** Every case explicit, and a `default` that
  throws. Two cases today is not a reason to skip it.
- **Every promise is awaited or explicitly voided.**
- **Comments explain a non-obvious why**: a constraint, a race, a workaround, something genuinely
  surprising. A comment that restates the code is noise; delete it.
- **Replace, do not layer.** When you change something, remove the old path in the same change
  rather than leaving a shim behind it. The exception is anything the other side of a wire depends
  on.

## Before you open a pull request

- `pnpm typecheck` and `pnpm test` pass.
- The smokes that cover what you touched pass.
- If you changed the client, it still launches.
- No secrets, machine-specific paths, host names or personal data anywhere in the diff, tests and
  fixtures included.
- Commits are focused and the message says what changed and why. Reference the issue.
