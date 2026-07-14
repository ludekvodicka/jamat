# Configuration

## The config-dir

All of Jamat's portable state lives in **one directory** — config, app-state (windows/layout),
usage cache, stats, ideas. It defaults to **`~/.jamat`** and is selectable:

| How | Selects the config-dir |
|---|---|
| `bin/start.bat <config-dir>` | the desktop launcher's first arg (mac/linux: `bin/start.sh`) |
| `JAMAT_CONFIG_DIR=<dir>` | environment variable (all entry points) |
| `--config-dir <dir>` | CLI / agent flag |
| *(nothing)* | `~/.jamat` (dev: `~/.jamat-debug`) |

Point it at a **synced directory** (e.g. a Dropbox/SVN folder) to share your settings + state across
machines, or at an **empty directory** to run a fresh setup wizard. The config file is always
`<config-dir>/config.json` (secret overlay: `<config-dir>/config.local.json`).

`remote-control.json` (this machine's LAN control key + peers) lives in the config-dir too, so ALL
config sits in one place. Each PC uses its OWN config-dir, so the key stays per-machine — it's just
relocated next to the config it belongs with (the app moves it out of the legacy `%APPDATA%\jamat` on
first launch). `%APPDATA%\jamat` then keeps only Electron's own caches. The localhost `jamat` gateway
is loopback-trusted, so the CLI no longer needs the key; only the LAN listener + the agent read it.

## Migrating a PC onto a synced config-dir (one-time seeding)

> **Do this on every PC that ran Jamat in default mode before switching to a synced config-dir**
> (e.g. when you point a second machine at a shared, synced config-dir).

Switching to an explicit config-dir (`--config-dir` / `JAMAT_CONFIG_DIR`) does **not** auto-migrate
this machine's existing state into it — that auto-migration runs **only** for the default `~/.jamat`.
An explicit dir is used **verbatim** on purpose: it's treated as the synced source of truth (don't
pour a machine's local state over an already-synced dir) or as a clean dir for the setup wizard. See
`core/config-dir.ts` (`migrateIntoConfigDir` is gated `if (!JAMAT_CONFIG_DIR)`) and
`app-electron/src/main/bootstrap-userdata.ts`.

**Symptom:** `config.json` is synced so your **project folders show up**, but the **window list /
saved windows / tab layouts / notes are empty** — they live in `app-state.json`, which in default
mode sat in `%APPDATA%\jamat\app-state.json` and was never carried into the config-dir.

**Confirm in-app:** **Settings → Info** shows the resolved `App state` path and whether the config
source is *explicit* vs *default* — if `App state` points at the synced dir and is near-empty, you
need to seed it.

**Fix — one-time per PC, with Jamat CLOSED** (a running Jamat overwrites `app-state.json` on quit, so
the copy must happen while it's not running). Replace `<user>` with that PC's config-dir:

```powershell
$appdata = Join-Path $env:APPDATA 'jamat'
$dir     = 'C:\path\to\jamat\.private\configs\<user>'
Get-Process Jamat -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep 2
Copy-Item "$dir\app-state.json" "$dir\app-state.pre-recovery.json" -Force   # backup (revertible)
Copy-Item "$appdata\app-state.json" "$dir\app-state.json" -Force            # the window list
foreach ($f in 'ideas-0.json','ideas-1.json','usage-stats.json') {          # other portable files
  if ((Test-Path "$appdata\$f") -and -not (Test-Path "$dir\$f")) { Copy-Item "$appdata\$f" "$dir\$f" }
}
foreach ($d in 'stats','remote-activity') {
  if ((Test-Path "$appdata\$d") -and -not (Test-Path "$dir\$d")) { Copy-Item "$appdata\$d" "$dir\$d" -Recurse }
}
```

You don't need to copy `remote-control.json` by hand — the app moves this machine's key from the
legacy `%APPDATA%\jamat` into the config-dir automatically on first launch (non-clobber, so a key
already synced into the config-dir wins). It then syncs with the rest of the config.

After seeding, relaunch `bin/start.bat <config-dir>`. Only the window that was open at last save
auto-opens; the rest of the saved windows are in the native **Window** menu (their layouts are
preserved). The config-dir then syncs via SVN, so you only seed **once per PC** that had prior
default-mode state. Note: saved window **bounds** are machine-specific, but Jamat ignores off-screen
bounds on restore (`visibleBounds`), so a different monitor layout is harmless.

## Editing — no JSON needed

**In the desktop app you don't have to touch JSON.** On first launch it opens **Settings** with a
*Get started* checklist (add a project folder, pick your agent — see [onboarding.md](onboarding.md));
every field below is editable from **Settings** (Projects, General, Project menus, Updates, Quick
prompts, Usage), which writes back to `<config-dir>/config.json`. Re-open the guide via
**Settings → ↻ Setup guide**.

Hand-editing still works and is the path for the headless CLI / agent: start from the template —
`cp configs/config.example.json <config-dir>/config.json` (or just point `--config-dir` at a fresh
dir and let first-run seed it). `configs/config.example.json` documents every field inline.

## Fields

| Field | Type | Purpose |
|---|---|---|
| `name` | string | A label for this machine (shown in the UI, used by the bridge). |
| `categories` | array | The project roots Jamat scans — **the one field you must set**. |
| `defaultAgent` | `"claude"` | Which agent the menu preselects: its `＋ New <Agent> session` row is listed first in the session picker, and it's the agent a launch uses unless another is picked (`codex` also accepted; falls back to an installed agent if the chosen one isn't on PATH). Edit in **Settings → Agents**. |
| `dockerIsolation` | boolean | `false` hides the start menu's "Isolated (Docker)?" create prompt + 🐳 marker — set it on machines without Docker. Default (absent/`true`) = offered. |
| `selfUpdate` | object | Update knobs (`autoCheck`, `checkIntervalMinutes`) — the channel itself follows the runtime. See [Self-update](#self-update). |
| `customMenus` | array | Your own per-project actions (press **F3** on a project). See [Custom menus](#custom-menus). |
| `sessionDonePrompts` | array | One-click quick prompts shown when a session finishes a turn. See [Session-done prompts](#session-done-prompts). |

### `categories`

Each category is a top-level folder Jamat scans for projects:

```jsonc
{
  "label": "Projects",
  "path": "C:\\Code\\projects",          // absolute; macOS/Linux e.g. /home/you/code
  "hiddenFolders": ["archive", "docs"],   // optional — skip these subfolders
  "virtualFolders": [                      // optional — group by name prefix
    { "prefix": "temporary", "title": "Temporary projects" }
  ]
}
```

Replace the example paths with your own.

### Self-update

```jsonc
"selfUpdate": { "autoCheck": true, "checkIntervalMinutes": 120 }
```

**The update channel follows how the app RUNS — the config cannot pick it:**

- **Installed build** (Windows + Linux) — auto-updates from this project's GitHub Releases. macOS
  needs a signed build, so it has no channel and updates manually.
- **Running from source** — the app makes **no network check and runs no VCS command**. It compares
  itself to the sources on disk and offers a restart (the launcher recompiles). Updating the sources
  is your job (`svn update` / `git pull`).

Keys: `"autoCheck": false` silences only the background check (the menu action still works);
`"checkIntervalMinutes"` sets the cadence (default 120 installed / 15 from source). The old
`provider` / `vcs` / `repoPath` keys are **ignored** — a config carrying them still loads and shows a
warning in Settings → Updates.

Every check, download, prompt — and every prompt that was *suppressed*, with the reason — is appended
to `<config-dir>/update-log.jsonl`, which survives the restart an update causes.

### Custom menus

Add your own actions to the start menu (opened with **F3** on a non-Docker-isolated project). A node
is either a **group** (opens a sub-menu) or a **command** (runs against the selected project).
`{dir}` (absolute project path) and `{name}` (folder name) are substituted in `args` / `cwd`:

```jsonc
"customMenus": [
  { "label": "Deploy", "items": [
    { "label": "Build", "run": { "command": "npm", "args": ["run", "build"], "cwd": "{dir}" } }
  ]}
]
```

Groups nest freely. Empty / absent = no custom actions.

### Session-done prompts

The one-click quick prompts in the bottom-right popup (Electron) when a session finishes a
non-trivial turn on the active tab. Each `{label, prompt}` is typed in + Enter on click. Omit to use
a small built-in default; toggle the popup in **Settings → Notifications**.

```jsonc
"sessionDonePrompts": [
  { "label": "Continue",  "prompt": "What should we do next?" },
  { "label": "Summarize", "prompt": "Summarize what you just did." }
]
```

## Secrets — never in this file

The Claude.ai usage credentials (for the cost dashboard) live in a **sibling** of the config file,
`<config-dir>/config.local.json`:

```jsonc
{ "claudeUsage": { "orgId": "...", "sessionKey": "sk-ant-..." } }
```

`core/config.ts` merges that overlay at load time, next to the config file — it is never committed
and never bundled into the exe. Omit it entirely and the usage dashboard is simply empty; everything
else still works.

> The `:3500` LAN relay has its own deploy config (`app-agent/config-remote.example.json`) — that is
> **not** a per-user app config. See [remote-and-bridge.md](remote-and-bridge.md).
