# Onboarding & in-app settings

The Jamat desktop app is configurable entirely from its UI — a fresh install never requires editing
a JSON file by hand.

## First launch

On the very first launch (no config yet) Jamat:

1. Seeds a starter config pointing at a new empty `~/JamatProjects` folder, so the app boots
   immediately.
2. Opens **Settings** in **guided mode** — a *Get started* checklist at the top of the panel:

   - **Add a project folder** *(required)* — jumps to the **Projects** tab; pick the folder(s) where
     you keep your projects (native folder picker).
   - **Choose your default agent** *(required)* — jumps to **General**.
   - **Connect usage stats** *(optional)* — jumps to **Usage** (Claude.ai credentials for the cost
     dashboard; stored only in the gitignored `*.local.json` overlay, never committed).

   Each item ticks itself as you save the matching tab. When the required items are done, **Finish
   setup** marks onboarding complete so the guide doesn't reopen on later launches.

You can re-open the guide anytime via **Settings → ↻ Setup guide** (it doesn't reset anything — just
shows the checklist again).

## Editing settings later

Every field that lives in the per-machine config is editable from **Settings**:

| Tab | Edits |
|---|---|
| **Projects** | `categories` — project folders (add/remove/reorder, native folder picker, "not found" hint) |
| **General** | `name`, `dockerIsolation` |
| **Agents** | `defaultAgent` (the agent the menu lists first + preselects) and `agents` — per-agent pre-launch hooks |
| **Project menus** | `customMenus` — the recursive F3 action menus (groups + commands) |
| **Updates** | `selfUpdate` (gated behind an "enable" toggle) |
| **Quick prompts** | `sessionDonePrompts` |
| **Usage** | Claude.ai credentials → the `*.local.json` overlay |

Saving validates with the same rules as load, writes the file atomically, and applies live across
all open windows (no restart). A change to `categories` is refused if no folder exists, so the app
can never be configured into a state that won't boot. Saving from Settings rewrites the file as plain
JSON — any `//` comments added by hand are not preserved.

## Where it lives

Everything portable (config, app-state, usage cache, stats, ideas) lives in one **config-dir**,
default `~/.jamat`, selectable with `bin/start.bat <config-dir>` (mac/linux `bin/start.sh`) /
`JAMAT_CONFIG_DIR` / `--config-dir`.
Point it at a synced folder to share settings across machines; point it at an empty dir to get the
wizard. `remote-control.json` (the LAN key) lives in the config-dir too (each PC uses its own, so the
key stays per-machine); `%APPDATA%\jamat` keeps only Electron's caches. Full reference:
[configuration.md](configuration.md).

## CLI / agent

The headless CLI and agent have no UI: on first run they seed `<config-dir>/config.json` and print a
notice telling you which file to edit. Configure those by editing the JSON or by running the desktop
app once to set things up — they all read the same config-dir (default `~/.jamat`, or pass
`--config-dir`).
