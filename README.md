# Jamat

**Just Another Multi-Agent Terminal** — an open-source desktop control center for running many
[Claude Code](https://www.anthropic.com/claude-code) sessions in one tiling workspace, and for
reaching the sessions running on your other computers across the network — including letting one
AI agent operate another's tab.

> **Status:** Early and a work in progress. **Windows today** (macOS & Linux soon).
> **Claude Code today** (Codex / GPT and other agents soon). Built as a personal project in spare
> time, open-sourced because it might help you too. No company, no roadmap promises beyond "soon".

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/ludekvodicka/jamat/actions/workflows/ci.yml/badge.svg)](https://github.com/ludekvodicka/jamat/actions)

---

## What it does

You're running Claude Code in five tabs — and another two on the PC in the next room. Jamat puts
every session in one tiling workspace, shows you which agent is **working** and which is **waiting
on you**, and lets you reach (or hand work to) the agents on your **other machines**. Open source,
self-hosted, your keys — nothing is proxied.

**Day to day:**

- **Quick project & session selector** — a command palette lists your projects and each project's
  recent sessions; resume the exact session by name or open a new tab, no hunting for `--resume` IDs.
- **Easy compaction** — when context fills up, a one-click **Compact now** nudge runs `/compact` at
  thresholds you set (also on the status bar and the tab menu).
- **Predefined messages** — reply to a finished agent in one click: "Continue", "Summarize", or your
  own quick prompts, typed & sent for you.
- **Detailed Claude stats** — a usage dashboard breaks cost & tokens down by project and model
  (input / output / cache), across 1h / 5h / 24h windows.

…plus cross-machine control, AI-operates-AI, phone access, and skill/MCP management — see
**Highlights** below.

## Highlights

- **Every session in one window** — tiling, dockable, multi-window / multi-tab workspace with full
  position / size / layout persistence, named & colored windows, and per-directory project selection.
- **Never lose an agent** — live per-tab **working / waiting-on-you / completed** detection, so at a
  glance you always know which tab is busy and which one is waiting on you.
- **See exactly what changed** — diffs **by git/SVN history, by session, or by individual message**;
  file / changes / directory viewers; session search across all projects; commit helpers (never
  auto-commits).
- **Reach across machines** — over your LAN, take over a session running on another computer, or
  hand a task to a remote agent; the remote work shows up in a dedicated, highlighted tab.
- **AI that operates AI** — one agent can drive another agent's tab (this machine or another),
  handing over context and data — full UI-level control, not just a CLI hook.
- **From your phone** — wake your PC (Wake-on-LAN) and launch a session via a small web app, then
  drive it through Claude Code's own interface (native mobile app soon).
- **Insight & extensibility** — discover and toggle Claude **skills, slash-commands, subagents, MCP
  servers, and plugins** from inside the app; rich Markdown + diagram rendering (Mermaid, Graphviz,
  Vega-Lite, Archify).

## Architecture

Jamat is a TypeScript monorepo; several entry points share one core of business logic.

| Folder | What it is |
|---|---|
| `core/` | Shared, dependency-free logic (types, config, project engine, agent adapters, the AI bridge). |
| `app-electron/` | The desktop app — Electron + React + [dockview](https://dockview.dev) + [xterm.js](https://xtermjs.org) + [node-pty](https://github.com/microsoft/node-pty). |
| `app-cli/` | A terminal menu + a scriptable bridge client (`jamat`). |
| `app-agent/` | A per-machine REST API + a small LAN relay + the mobile launch web app. |
| `app-stats/` | Usage / cost dashboard (ccusage → HTML). |
| `app-wol/` | A standalone Wake-on-LAN proxy for an always-on device. |
| `dockerized-claude/` | A Docker image (`Dockerfile` + `entrypoint.sh`) that runs Claude Code sandboxed in a container — non-root user, `--dangerously-skip-permissions`, privileges dropped via gosu. |
| `skills/` | Claude Code skills that ship with the app — `jamat` (drive the bridge from an agent) and `mdext-renderer` (Markdown/diagram authoring guidance); surfaced into `~/.claude/skills` (run `bin/enable-jamat-skill.ps1` once). |
| `scripts/` | Build, version-bump, demo-seeding, and the `smoke-*.ts` test suite (run by `npm test`). |
| `configs/` | The public `config.example.json` template — copy it to create your own per-user config. |
| `bin/` | Cross-platform launchers — `start`, `start-dev`, `start-menu` (`.bat` + `.sh`) — plus the one-time `enable-jamat-skill.ps1` setup. |

## Quick start

**Prerequisites:** Node.js 20+, Windows, and [Claude Code](https://www.anthropic.com/claude-code)
installed and on your `PATH`.

```bash
# 1. Install dependencies (two installs: root + the Electron app)
npm install
cd app-electron && npm install && cd ..

# 2a. Run the desktop app — first launch opens a guided Settings wizard; no config to edit
bin\start.bat                   # compiled app (builds on first run); arg: bin\start.bat <config-dir>
bin\start-dev.bat               # …or dev mode (electron-vite).  mac/linux: bin/start.sh · bin/start-dev.sh

# 2b. …or the terminal menu (headless — seeds a starter config + prints what to edit)
bin\start-menu.bat              # the app-cli TUI (mac/linux: bin/start-menu.sh); arg: <config-dir>

# 2c. …or the mobile-remote agent server
node --import tsx app-agent/agent-server.ts    # optional: --config-dir <dir>
```

All portable state (config, app-state, usage, stats, ideas) lives in one **config-dir** — default
`~/.jamat`, or pass `bin/start.bat <config-dir>` / `--config-dir <dir>` (point it at a synced folder to
share settings across machines, or an empty dir for a fresh wizard).

**Desktop:** on first launch Jamat seeds a starter config and opens **Settings** with a *Get started*
checklist — add a project folder (native picker), pick your agent, done. Everything is editable from
Settings later; you never touch JSON. See [docs/onboarding.md](docs/onboarding.md) /
[docs/configuration.md](docs/configuration.md).

## Security

Jamat can expose a LAN control surface (launch sessions, open tabs, inject into a remote agent), so
treat it like any tool with remote-execution reach:

- **Remote control and the AI bridge are off by default** and loopback-only until you opt in.
- The LAN surface is **token-gated** (each machine has its own key), the operation registry is
  **closed-by-default**, remote file access is **path-scoped**, and **every remote action is
  audit-logged**.
- Only enable LAN control on networks you trust.

Found a vulnerability? Please report it privately — see [SECURITY.md](SECURITY.md).

## Roadmap

Honest "soon", no dates:

- macOS & Linux builds
- More agents via the pluggable adapter layer (Codex / GPT and others)
- A native mobile app that remote-controls the desktop app directly

## Contributing

Issues and PRs are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) and our
[Code of Conduct](CODE_OF_CONDUCT.md).

## The story

Jamat is a personal project, built in spare time to scratch one developer's own itch: running a
growing pile of Claude Code agents across several machines without losing the plot. It worked well
enough day-to-day that it seemed worth sharing — so it's open source, self-hosted, and free.

## License

[MIT](LICENSE) © Jamat contributors.

---

*Not affiliated with Anthropic. "Claude" and "Claude Code" are products of Anthropic; Jamat is an
independent tool that runs them as your own local subprocesses, on your own keys.*
