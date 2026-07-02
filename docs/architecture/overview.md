# Architecture overview

Jamat is a TypeScript monorepo. Several entry points share **one core of business logic** so the
desktop app, the terminal menu, and the per-machine REST server all behave identically.

## Packages

| Package | What it is |
|---|---|
| `core/` | Shared, dependency-free logic — types, config loading, the project/menu engine, agent adapters, and the AI bridge. |
| `app-electron/` | The desktop app — Electron + React + [dockview](https://dockview.dev) (tiling) + [xterm.js](https://xtermjs.org) + [node-pty](https://github.com/microsoft/node-pty) (real PTYs). |
| `app-cli/` | A terminal menu, plus a scriptable bridge client (`jamat`). |
| `app-agent/` | A per-machine REST API, a small LAN relay, and the mobile launch web app. |
| `app-stats/` | A usage / cost dashboard (ccusage → HTML). |
| `app-wol/` | A standalone Wake-on-LAN proxy you run on an always-on device. |

## The `core/` contract

`core/` is the single source of truth, and it stays portable by following five rules:

1. **No UI or framework deps** — no Electron, no HTTP server, no readline in `core/`.
2. **`app-*` depends on `core/`, never the reverse.**
3. **`app-*` never imports from another `app-*`** — each entry point is independent.
4. **Types are canonical in `core/types.ts`** — no duplicate definitions in the apps.
5. **`core/` takes paths as parameters** — it never reads `__dirname` (which breaks inside an
   Electron bundle).

The practical payoff: launching a session, scanning projects, resolving config, and driving the AI
bridge work the same whether you start from the desktop app, the CLI, or the agent server.

## From config to a running session

1. **Config** (`core/config.ts`) resolves a per-machine `config.json` — your **category roots**
   (the folders that hold your projects) plus options. See [configuration.md](../configuration.md).
2. **Project scan** walks those roots into the start menu.
3. **Launch** spawns Claude Code as a child process in a PTY; the desktop app renders it in a
   dockable xterm tab, the CLI runs it inline.
4. **Status detection** watches each session's output to classify it **working /
   waiting-on-you / completed**.

## Reaching across machines

Each machine can run a control surface with two listeners: a **loopback** listener that is always on
(for this machine's own AI / CLI), and a **LAN** listener that is **off by default** and only binds
once you opt in. Both are token-gated. On top of that sits the **AI bridge** — a protocol that hands
a task to another machine's agent (or this machine's own) and awaits its answer.

This surface has remote-execution reach, so it is closed-by-default and audit-logged. See
[remote-and-bridge.md](../remote-and-bridge.md) for setup and [architecture/security-model.md](security-model.md)
for the threat model.

## Markdown & diagram rendering

The file viewer renders Markdown richly (GFM, syntax-highlighted code, collapsible frontmatter) and
inline diagrams — Mermaid, Graphviz, Vega-Lite, Archify — via a self-contained, sandboxed renderer
widget (raw HTML is stripped; output is safe on untrusted input).
