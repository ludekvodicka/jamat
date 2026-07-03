# Jamat — Screenshots

Screenshot gallery for the README and docs. Each entry is a captured view of the app with a short
note on what it shows. All shots are from a **Demo** window (dummy projects/sessions), safe to publish.

To embed one in the top-level `README.md`, reference it by relative path, e.g.
`![Overview](docs/images/01-overview.png)`.

| # | File | Shows |
|---|------|-------|
| 00 | [`00-overview.gif`](00-overview.gif) | Animated hero — the app in motion (README lead) |
| 01 | [`01-overview.png`](01-overview.png) | Main overview — the whole app at a glance |
| 02 | [`02-tab-status.png`](02-tab-status.png) | Per-tab status signaling (working / waiting / done) |
| 03 | [`03-side-panel.png`](03-side-panel.png) | Side panel — prepared notes + recent files |
| 04 | [`04-file-view.png`](04-file-view.png) | File view window |
| 05 | [`05-settings.png`](05-settings.png) | Settings — what's configurable |
| 06 | [`06-diff-view.png`](06-diff-view.png) | Diff view with the "Diff against…" selector |
| 07 | [`07-window-groups.png`](07-window-groups.png) | Multiple colored windows for different tab groups |
| 08 | [`08-status-bar.png`](08-status-bar.png) | Status bar — model, context, hourly & weekly limits |
| 09 | [`09-remote-connections.png`](09-remote-connections.png) | Remote connections — LAN control & peer machines |
| 10 | [`10-file-context-menu.png`](10-file-context-menu.png) | Right-click a file mentioned in output to open it |
| 11 | [`11-new-tab-picker.png`](11-new-tab-picker.png) | New-tab picker (Ctrl+Shift+T) — grouped launcher |
| 12 | [`12-help.png`](12-help.png) | Help — all keyboard shortcuts & tab types |
| 13 | [`13-usage-stats.png`](13-usage-stats.png) | Usage stats dashboard — tokens, spend, models |
| 14 | [`14-context-nudge.png`](14-context-nudge.png) | Context-full nudge — one-click Compact now |
| — | [`output-architecture.png`](output-architecture.png) | Rich mdext output — an agent's Jamat architecture map (part 1) |
| — | [`output-architecture-2.png`](output-architecture-2.png) | Rich mdext output — architecture map, part 2 (package map + sequence) |
| — | [`remote-control.png`](remote-control.png) | Remote control surface — drive a peer's tabs, open a tab, read-only file view (human mode) |
| — | [`remote-session.png`](remote-session.png) | A remote peer's Claude session mirrored live in a Jamat tab |
| — | [`remote-ai-to-ai.png`](remote-ai-to-ai.png) | AI mode — a local Claude told to connect to a peer and run tests, driving the bridge itself |
| — | [`project-selector.png`](project-selector.png) | Day-to-day inline — CLI project & session selector (folders, search, recent sessions) |
| — | [`compact-statusbar.png`](compact-statusbar.png) | Day-to-day inline — status bar with the one-click Compact button |
| — | [`predefined-messages.png`](predefined-messages.png) | Day-to-day inline — finished-agent notification with What's next? / Continue quick replies |
| — | [`recent-files.png`](recent-files.png) | Highlights inline — recent-files panel with History / Changes entry into diffs |
| — | [`open-from-output.png`](open-from-output.png) | Highlights inline — right-click menu to open a file path from a session's output |
| — | [`remote-peer.png`](remote-peer.png) | Highlights inline — a remote peer online in the connections panel (ctrl/agent ports + token) |

---

## 00 — Overview (animated hero)

![Overview animation](00-overview.gif)

The animated lead used at the top of the repo `README.md` — the app in motion. Static stills of the
same views follow below.

## 01 — Overview

![Overview](01-overview.png)

The one image that shows what Jamat is. The tiling workspace: on the left the **project & session
selector** (folders across the top, fuzzy search, and each project's recent sessions with usage
counts and last-used times); on the right a **live Claude Code agent tab** rendering the agent's
output; the **tab bar** spanning multiple windows up top; and the **status bar** with the app
version and key shortcuts (Search, Manage, Docker, Sort) at the bottom.

## 02 — Tab status signaling

![Tab status](02-tab-status.png)

Per-tab **working / waiting-on-you / completed** detection. Each tab carries a colored dot for its
state, so at a glance you know which agent is busy and which one is waiting on you — across every
window in the workspace.

## 03 — Side panel: notes & recent files

![Side panel](03-side-panel.png)

The session side panel. **NOTES** (top) is a list of prepared, reusable notes/prompts you can paste
into the prompt in one click — add your own, or import from the current prompt. **RECENT FILES**
(bottom) lists the files changed within the session with relative timestamps, plus **History** and
**Changes** entry points.

## 04 — File view

![File view](04-file-view.png)

The file view window: a path breadcrumb with quick actions (**Open folder**, **Copy**, **Copy path**,
**Diff against…**, **Edit**, **VS Code**) above syntax-highlighted source.

## 05 — Settings

![Settings](05-settings.png)

The Settings screen, showing how much is configurable — a left nav across every area (**Projects**,
**General**, **Project menus**, **Appearance**, **Terminal**, **Notifications**, **Context warnings**,
**Recent Files**, **Quick prompts**, **Usage**, **Updates**, **Remote connection**, **Debug**,
**Info**), with the **Projects** pane open: the folders Jamat scans, each becoming a category in the
start menu and sidebar, saved to the committed `config.json`.

## 06 — Diff view

![Diff view](06-diff-view.png)

The file view in diff mode. The **Diff against…** selector picks the baseline to compare the current
file against, grouped into **Working copy** (git "Since last commit …" / svn "Since BASE …") and
**Claude session** (Since session start / last turn / N turns ago). The body renders a colored
line-by-line diff with add/remove markers and a per-hunk summary.

## 07 — Window groups (colored windows)

![Window groups](07-window-groups.png)

Several Jamat windows open at once, each a **named, colored window group** (Web system, Sandbox,
Docs) so you can tell them apart at a glance — the color carries into each window's status bar. The
**Window** menu manages them: **New Window**, jump to any named window, **Window Group Settings…**,
and **Clear Window Name**.

## 08 — Status bar

![Status bar](08-status-bar.png)

The per-tab status bar. Left to right: the app **version**, the run mode (**Development**), the
**model + context** readout (`Opus 4.8 · xhigh · 128k / 1M · 13%` — model, reasoning effort, context
window used / total, percentage), and the usage meters — **S** (hourly / 5-hour limit) and **W**
(weekly limit), each with a percentage and a fill bar.

## 09 — Remote connections

![Remote connections](09-remote-connections.png)

The Remote connections settings. **This machine (server)** toggles **Allow remote control** (off by
default), showing the port it listens on, this PC's addresses, and a **token** (reveal / copy /
rotate) another machine needs to connect. **Remote connections** lists the peer machines with their
**ctrl port** (view & drive the peer's tabs), **agent port** (launch the app when it's closed), and
per-peer token — each with an **Open** action. A **SELF (loopback debug)** entry drives this same
machine.

## 10 — File context menu

![File context menu](10-file-context-menu.png)

Right-clicking a **file path mentioned in a session's output** offers to open it directly — in a
Jamat tab or in VS Code — or to open the whole project in VS Code, plus paste actions. Turns any
path the agent prints into a one-click jump to the file.

## 11 — New-tab picker

![New-tab picker](11-new-tab-picker.png)

**Ctrl+Shift+T** opens the new-tab picker — a launcher grouped into **Agents** (Claude Code, Codex),
**Shells** (CMD, PowerShell), **Tools** (Usage Stats, Ideas, Claude Abilities, Remote connections),
and **App** (Error Log, Help, Settings), each with its shortcut.

## 12 — Help

![Help](12-help.png)

The in-app **Help** page — every keyboard shortcut grouped by area (Tab Management, Layout, Panels &
Windows, Terminal) plus the tab types, all on one scrollable page (**F1**).

## 13 — Usage stats

![Usage stats](13-usage-stats.png)

The **Usage Stats** dashboard: all-time / today / 30-day tokens, session count and total spend; a
tokens-over-time chart; a 26-week activity heatmap; per-model breakdown (input / output / cached /
cost / share); and a daily-consumption table — across Overview / 24h / 5h / 1h tabs.

## 14 — Context-full nudge

![Context-full nudge](14-context-nudge.png)

The compaction nudge: when a session grows past a threshold you set, a card offers **Compact now**
(runs `/compact`) or **Postpone**. It only fires on an idle session (turn finished, prompt waiting),
never mid-turn.

---

## Output examples — mdext rendering

An example of agent-authored **output** (not app chrome): we asked an agent to map Jamat's
architecture, and it produced [`docs/jamat-architecture.md`](../jamat-architecture.md) — a single
mdext document rendered live in the file viewer, with an Archify system diagram, a package map, and a
cross-machine sequence. Two views of that page:

![mdext output — architecture map, part 1: Archify system diagram + core/ component grid](output-architecture.png)

![mdext output — architecture map, part 2: package map, dependency rule, and cross-machine sequence](output-architecture-2.png)

---

## Remote connections — human control & live session

Two detail shots used in the README's **Remote connections** section (the gallery's `09-` is the
Settings-pane summary; these show the full reach).

![Remote control surface — a peer's windows & tabs, fork/open a session, read-only file view, and debug controls](remote-control.png)

**Human mode** — the full control surface over a connected peer: **Windows & tabs** (click a terminal
to open its live viewer; **fork** a Claude session into a new tab, history kept), **Debug / control**
(Logs / Terminals / Restart), **Open a new tab** on the peer, and **View a file (read-only)**
path-scoped to the peer's project roots. Project rows + hostname were blurred at capture.

![A remote peer's Claude session mirrored live in a Jamat tab](remote-session.png)

A peer's Claude session opened as its own **`WORK-PC: Claude (remote)`** tab, streaming live next to
the connections panel. The work email + an internal path in the terminal's welcome banner were
redacted for publication.

![A local Claude, told to connect to a peer (WORK-PC) and run tests, driving Jamat's remote bridge itself](remote-ai-to-ai.png)

**AI mode** — used in the README's **AI that operates AI** section. A local Claude was handed
`connect to WORK-PC and run tests on AppJamat`; via the built-in **`jamat` skill** it drives the
bridge itself — reaching the peer and starting the work, no human in the loop. Welcome-banner email +
path redacted, same as above.
