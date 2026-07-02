# Contributing to Jamat

Thanks for your interest! Jamat is a personal project that grew into something worth sharing, so
contributions, bug reports, and ideas are all welcome. Please keep it friendly — see the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to help

- **Report a bug** — open an issue with steps to reproduce, your OS, and what you expected.
- **Suggest a feature** — open an issue describing the problem first, then the idea.
- **Send a PR** — for anything non-trivial, please open an issue to discuss the approach before
  writing a lot of code, so we don't both spend effort on something that won't merge.
- **Security issues** — do **not** open a public issue; see [SECURITY.md](SECURITY.md).

## How your changes land

Jamat is developed in a separate primary working tree, and this GitHub repo is kept in sync from it.
Your PRs are very welcome — a merged PR is integrated back into that tree by hand and shows up in a
later sync commit here (so it may be squashed or re-authored rather than preserved verbatim). None of
this changes how you contribute: open an issue, send a PR, and it will be picked up.

## Development setup

**Prerequisites:** Node.js 20+, Windows (macOS/Linux support is in progress), and
[Claude Code](https://www.anthropic.com/claude-code) installed.

```bash
# Two installs — root (CLI + agent + tooling) and the Electron app
npm install
cd app-electron && npm install && cd ..
```

Create a local config from the template and point it at your own dev folders:

```bash
cp configs/config.example.json configs/config.json
```

Run a surface:

```bash
# Desktop (dev)
cd app-electron && npx electron-vite dev      # set JAMAT_CONFIG=config.json first

# Terminal menu
node --import tsx app-cli/executor.ts --config configs/config.json
```

## Before you open a PR

```bash
npm run typecheck     # tsc --noEmit across root + electron (node + web)
npm test              # or the focused smoke scripts: npm run smoke:jamat, etc.
```

- **Both must pass.** PRs that don't type-check or that break smokes won't merge.
- If you touched the desktop app, please confirm it still launches.

## Code style

- **TypeScript everywhere**, ESM, run via `tsx` (no separate build step for `core`/CLI/agent).
- **`core/` stays dependency-free** and framework-free — no Electron, no HTTP server, no UI. It is
  the shared logic that every entry point imports; entry points depend on `core/`, never the reverse,
  and never on each other.
- **Types are canonical in `core/`** — don't duplicate type definitions in `app-*`.
- **Imports are relative** (no path aliases).
- Match the style of the file you're editing — brace and comment conventions, naming, and structure.
  Keep comments for the non-obvious *why*, not a restatement of the code.

## Commits & PRs

- Keep commits focused; write a clear description of *what changed and why*.
- Reference the issue your PR addresses.
- Small, reviewable PRs merge faster than large ones.

## Project layout

See the architecture table in the [README](README.md#architecture) for what each package does.
