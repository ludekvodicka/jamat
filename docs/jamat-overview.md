---
title: Jamat — Documentation Overview
subtitle: One workspace for every Claude Code session, on every machine you own
version: 2026.07.02
status: stable · living document
license: MIT
---

# Jamat — Documentation Overview

**Jamat** (*Just Another Multi-Agent Terminal*) is an open-source desktop control center for running
many [Claude Code](https://www.anthropic.com/claude-code) sessions in one tiling workspace, reaching
the sessions on your other computers over the LAN, and letting one AI agent operate another's tab.

::status{platform="Windows" agents="Claude Code" workspace=stable cross_machine=stable ai_bridge=beta mobile=beta license=MIT}

:::tip[You are reading this inside Jamat]
This page is rendered by Jamat's built-in **Markdown viewer** — the same viewer that opens any `.md`
file in a tab, with syntax-highlighted code, inline diagrams, callouts, and a collapsible frontmatter
strip. Everything below is plain Markdown; a plain editor still shows readable source.
:::

## What it gives you

| Area | Capability |
|---|---|
| **Workspace** | Tiling, dockable, multi-window / multi-tab layout with full position & size persistence. |
| **Awareness** | Live per-tab status — **working / waiting-on-you / done** — across every window. |
| **Flow** | Quick project & session selector, one-click `/compact` nudges, predefined quick replies. |
| **Insight** | Detailed usage & cost stats by project and model; diffs by git/SVN, session, or message. |
| **Reach** | Take over or delegate to a peer machine's agent over the LAN; drive it from your phone. |
| **Extend** | Discover & toggle skills, slash-commands, subagents, MCP servers, and plugins in-app. |

## How it fits together

Jamat is a TypeScript monorepo — several entry points share one dependency-free `core/`, which spawns
Claude Code as a local subprocess and bridges out to peers over the LAN.

```archify
{
  "schema_version": 1,
  "diagram_type": "architecture",
  "meta": { "title": "app-* → core → Claude, and out to peers", "viewBox": [880, 240] },
  "components": [
    { "id": "apps",   "type": "frontend", "label": "app-electron / app-cli / app-agent", "pos": [40, 90],  "size": [230, 70] },
    { "id": "core",   "type": "backend",  "label": "core/ — shared logic",               "pos": [330, 90], "size": [180, 70] },
    { "id": "claude", "type": "external", "label": "Claude Code subprocess",              "pos": [570, 30], "size": [270, 60] },
    { "id": "peer",   "type": "external", "label": "Peer machine over LAN",               "pos": [570, 150],"size": [270, 60] }
  ],
  "connections": [
    { "from": "apps", "to": "core",   "label": "import", "variant": "emphasis" },
    { "from": "core", "to": "claude", "label": "spawn" },
    { "from": "core", "to": "peer",   "label": "bridge", "variant": "security" }
  ]
}
```

## Get started in two commands

```bash
# 1. Install dependencies — root (CLI + agent) and the Electron app
npm install && cd app-electron && npm install && cd ..

# 2. Launch the desktop app — first run opens a guided Settings wizard (no JSON to edit)
bin\start.bat
```

Point Jamat at your own folders from **Settings** — each folder becomes a project in the selector:

```json
{
  "categories": [
    { "name": "Work",     "paths": ["C:/Projects/backend", "C:/Projects/web"] },
    { "name": "Personal", "paths": ["C:/Life/garden", "C:/Life/taxes"] }
  ],
  "defaultAgent": "claude"
}
```

## Keys you'll use most

| Shortcut | Action | | Shortcut | Action |
|---|---|---|---|---|
| **Ctrl+T** | New Claude Code tab | | **Ctrl+K** / **Ctrl+P** | Command palette |
| **Ctrl+Shift+T** | New-tab picker | | **Ctrl+H** | Session history search |
| **Ctrl+W** | Close active tab | | **Ctrl+J** | File-changes panel |
| **Ctrl+Tab** | Next / previous tab | | **Ctrl+U** | Usage & cost stats |
| **F2** | Rename the session | | **F1** | This help |

:::note[Security in one line]
Remote control and the AI bridge are **off by default** and loopback-only until you opt in — the LAN
surface is token-gated per machine, remote file access is path-scoped, and every remote action is
audit-logged. Anything a peer sends back is treated as **untrusted**.
:::

---

*Not affiliated with Anthropic. "Claude" and "Claude Code" are products of Anthropic; Jamat runs them
as your own local subprocesses, on your own keys. Licensed under [MIT](../LICENSE).*
