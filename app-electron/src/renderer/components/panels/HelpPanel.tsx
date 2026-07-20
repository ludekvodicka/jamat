import { IDockviewPanelProps } from 'dockview'
import { marked } from 'marked'

const HELP_CONTENT = `
# Jamat — Help

## Keyboard Shortcuts

### Tab Management
| Shortcut | Action |
|----------|--------|
| **Ctrl+T** | New Claude Code tab (opens Jamat Menu if configured) |
| **Ctrl+Shift+T** | New tab picker — grouped by section (Agents / Shells / Tools / App) |
| **Ctrl+W** | Close active tab (including last tab) |
| **Ctrl+Tab** | Switch to next tab |
| **Ctrl+Shift+Tab** | Switch to previous tab |
| **Ctrl+Shift+PageUp** | Move tab left within its group |
| **Ctrl+Shift+PageDown** | Move tab right within its group |
| **F2** | Edit the active session name and private AppJamat description |

### Layout
| Shortcut | Action |
|----------|--------|
| **Alt+T → Alt+N** | Move active tab right (create split or merge into existing group) |
| **Alt+T → Alt+P** | Move active tab left |
| **Alt+T → Alt+U** | Move active tab up |
| **Alt+T → Alt+D** | Move active tab down |
| **F11** | Maximize / restore active panel (fullscreen within layout) |
| **Tab → Reset Layout** | Merge all tabs into a single group |

### Panels & Windows
| Shortcut | Action |
|----------|--------|
| **Ctrl+B** | Toggle sidebar (panel list) |
| **Ctrl+G** | Toggle panel bar (notes) for active terminal |
| **Ctrl+K** / **Ctrl+P** | Command palette |
| **Ctrl+H** | Session history search (current project) |
| **Ctrl+J** | File changes panel (current session) |
| **Ctrl+Shift+F** | Search sessions (cross-session conversation search) |
| **Ctrl+I** | Ideas panel |
| **Ctrl+U** | Usage Stats panel |
| **Ctrl+Y** | Claude Abilities panel |
| **Ctrl+O** | Open selected file path in new tab |
| **Ctrl+N** | New empty window |
| **F1** | Show this help page |

### Terminal
| Shortcut | Action |
|----------|--------|
| **Ctrl+F** | Search in terminal scrollback |
| **Ctrl+V / Ctrl+Shift+V** | Paste from clipboard |
| **Ctrl+C** | Copy selection / Send SIGINT when no selection |
| **Ctrl+Shift+C** | Copy selection (native — keeps the selection) |
| **Shift+Enter** | Newline without submit (in agent prompts) |
| **Right-click** | Context menu (Copy, Open in VS Code, Open in Tab) |
| **Shift+Right-click** | Paste from clipboard |

### File Viewer
| Shortcut | Action |
|----------|--------|
| **Ctrl+E** | Toggle edit mode (edit the open file — local files only) |
| **Ctrl+S** | Save the file (while in edit mode) |
| **Ctrl+F** | Find within the open file |
| **Enter / Shift+Enter** | Jump to next / previous match (in the find bar) |
| **Esc** | Close the find bar / exit edit mode |

## Tab Types

The **Ctrl+Shift+T** picker groups tab types into sections:

### Agents
| Type | Shortcut | Description |
|------|----------|-------------|
| 🤖 **New Agent Session** | Ctrl+T | Jamat Menu → project selection → agent session. **Which** agent (Claude Code / Codex) is picked in the menu, not here. |

### Shells
| Type | Description |
|------|-------------|
| ⬛ **CMD** | Plain Windows Command Prompt |
| 🔷 **PowerShell** | Plain PowerShell terminal |

### Tools
| Type | Shortcut | Description |
|------|----------|-------------|
| 🌐 **Browser** | — | Web browser with URL bar, navigation (back/forward/reload) |
| 📊 **Usage Stats** | Ctrl+U | React usage dashboard (cost / tokens) |
| 💡 **Ideas** | Ctrl+I | Per-project ideas / TODO capture |
| 🧰 **Claude Abilities** | Ctrl+Y | Inventory of skills, commands, agents, MCP servers, plugins |
| 🛰 **Remote connections** | — | Connect to / drive other PCs' Claude sessions |

### App
| Type | Shortcut | Description |
|------|----------|-------------|
| ⚠ **Error Log** | — | In-app log of runtime errors |
| ❓ **Help** | F1 | This help page |
| ⚙ **Settings** | — | App settings (terminal, theme, behavior) |

## Features

### Terminal Management
- **Multiple terminals** in tabs with drag-and-drop between groups
- **Split view** — drag tabs to edges to create horizontal/vertical splits
- **Resizable panels** — drag borders between panels
- **Status indicator** — colored dot on tab showing terminal state:
  - Gray: idle (no activity)
  - Orange (pulsing): running (receiving output)
  - Red: blocked (Claude waiting for input/approval)
  - Green: done (Claude process finished)
- **Tab colors** — right-click tab → Appearance → choose from 10 pastel colors (persists per project)

### Jamat Menu Integration
- **Ctrl+T** opens Jamat Menu for project selection
- After selecting a project, Claude Code starts in the same tab
- After Claude Code exits, menu reappears for next project
- **F9** in standalone Jamat Menu opens selected project in Jamat
- Screen-managed lifecycle: menu → claude → menu (no PowerShell wrapper)

### Codex
- A second agent alongside Claude Code — every agent tab opens the same menu, and the session picker
  offers a **＋ New session** row per agent installed on PATH (plus the merged resume list, C/X badged)
- **Settings → Agents → Default agent** decides which one is listed first and preselected
- Sessions, history and discovery route through the agent that owns the session

### Session Persistence
- Layout (tabs, splits, positions) saved automatically on every change
- Session metadata (project directory, mode, session ID) saved per tab
- On restart, Claude Code sessions restore directly (skip menu)
- Layout saved immediately when closing tabs or windows

### Window Names
- Every window starts **unnamed** — open new ones with **Window → New Window** (Ctrl+N)
- **Window → Window Group Settings…** — give the focused window a name + color; it then appears in the named list
- Named windows are listed **alphabetically**; click one to focus it (or reopen it if closed)
- **Clear Window Name** — strips the name; the window stays open and reverts to unnamed
- All windows — named or unnamed — reopen on restart with their saved layout

### Panel Bar / Notes (Ctrl+G)
- Per-tab persistent notes sidebar (320px, right side)
- Multiple note entries with **+** button
- **Paste to terminal** button — sends note text to terminal and clears entry
- **📌 Sticky** toggle — keep note after pasting (don't clear)
- Notes auto-save (debounced 500ms) and persist across restarts

### File Viewer & Editor
- **Ctrl+O** — select a file path in terminal, press Ctrl+O to open it
- **Right-click** → **Open selected file** — same via context menu
- Also reads file path from clipboard in context menu
- Syntax highlighting via **Shiki** (VS Code Dark+ theme) for ~27 languages — TypeScript/TSX, JavaScript/JSX, HTML, CSS/SCSS, JSON/JSONC, Markdown, Python, Bash, PowerShell, YAML, SQL, Go, Rust, C/C++, C#, Dockerfile, diff, and more
- Markdown files rendered with full formatting (the shared mdext renderer — GFM, code, diagrams)
- **Auto-reload** — file viewer updates automatically when the file changes on disk

#### Toolbar (segmented view-mode group)
- Format-specific toggles — clicking switches the view AND turns off diff:
  - Markdown: **Formatted** / **Raw**
  - CSV / TSV: **Table** / **Raw**
  - SVG: **Preview** / **Source**
- **No diff** quick-toggle — appears only when a diff baseline is active; one click back to plain file view
- **Diff against ▾** dropdown — grouped picker:
  - **Working copy** — *Since last commit* (git HEAD), *Since HEAD~N* up to 5 commits back, or *Since BASE* for svn working copies (auto-detects, newer wins for mixed repos)
  - **Claude session** — *Since session start*, *Since last turn*, *Since N turns ago* (when the active session edited this file)
- **Edit** — opens textarea editor; **Ctrl+S** saves, **Discard** abandons, unsaved changes warned on close

#### Diff rendering
- Unified inline VS Code-style — \`+\` green / \`-\` red / context, with syntax highlighting overlaid
- Right-side **minimap** with viewport rectangle — click or drag to scroll the file
- Status pill: \`+N −M · Since last commit (date)\` or \`no changes — since …\` when baseline matches
- No-changes case keeps the file rendered normally (so opening a clean file isn't an empty page)
- Whole-file mode for session baselines uses anchored substitution; if the file diverged since the edit, falls back to region-only with a tagged label

### Recent Files (sidebar)
- Cross-directory list of recently edited files — merges filesystem walk + active-session JSONL edits
- Files edited within the last 5 minutes get a green background tint (brighter = more recent)
- **Left-click** opens the file in FileViewer with default diff baseline (Since last commit)
- **Right-click** opens a context menu:
  - **Open file** — opens without any diff (plain file view)
  - **Show changes** — opens with default diff (same as left-click)
  - **Show changes in prompts** — opens the per-project File Changes panel filtered to just this file (shows only Claude turns that touched it). Reopening for a different file re-filters the same panel rather than spawning duplicates.
  - **Copy file path** — copies absolute path to clipboard
- Refreshed automatically every \`recentFilesIntervalSeconds\` (see Settings) and via the ↻ button

### File Changes Panel (Ctrl+J)
- Per-project panel showing Claude's edits grouped by turn or by file
- **Session picker** at top — inspect any past session of the project; "● Active session" follows the current terminal
- **Session history** view — turns as a two-level tree (turn → files), select a file to see its diff
- **File history** view — flat file list with one composed net diff per file across the whole session
- Detail pane uses the **Region / Full file** toggle:
  - **Region** — shows just the hunk Claude edited (focused, with best-effort real file line numbers)
  - **Full file** — anchors the region into the current on-disk file and shows the whole thing with the minimap
  - Falls back to Region with a "region only — file diverged" label when the file changed since the edit
- **Filter banner** — when opened from RecentFiles → "Show changes in prompts", shows \`Filtered: <name> [×]\` with a clear button
- Cross-turn \`Write\` overwrites now compose against the running file state, so a single-Write turn shows a real diff against the previous Claude state instead of all-\`+\`

### Session History Search (Ctrl+H)
- **Ctrl+H** — search conversation logs across past Claude Code sessions for the current project
- **Search field** — type to find messages containing your query (case-insensitive)
- Results grouped by session with date/time; expand a session to view all its messages
- Full message history includes role (user/assistant) and content
- **Ctrl+Shift+F** — *Search Sessions…* opens the same cross-session search from the menu

### Ideas Panel (Ctrl+I)
- Per-project list of ideas / TODOs captured during work
- Importance (low → critical), optional due dates, and several sort modes (manual, newest, due, alpha)
- Persists per project so observations aren't lost between sessions

### Usage Stats (Ctrl+U)
- React dashboard — cost and token usage over time, rendered in-app

### Claude Abilities (Ctrl+Y)
- Inventory of what Claude can use: **Skills, Commands, Agents, MCP servers, Plugins, Instructions**
- User-level entries plus plugin-scoped ones (plugins expand to show their contents)
- Surfaces warnings (e.g. misconfigured entries) and lets you enable/disable items

### Remote Connections
- Connect to **other PCs** running Jamat and drive their sessions from here
- Peer registry with live **reachability** probing (offline / agent-only / app-up)
- Open a peer's terminals, files, changes and notes remotely; the **Remote Viewer** streams a peer terminal
- **Wake-on-LAN** can wake/launch a sleeping peer before connecting (only when you allow it)
- Off by default — enable via **Allow remote control** in the panel; access is gated by a per-machine key

### Error Log
- In-app panel listing runtime errors (time, source, message) so failures aren't lost to the console

### Settings
- App settings: terminal **scrollback**, cursor blink, xterm **renderer** (DOM vs WebGL), theme, the session-done prompt, and \`recentFilesIntervalSeconds\`
- Open from **File → Settings**

### Notifications
- Long-running tasks (> 1 minute) trigger a **toast notification** (bottom-right) when complete
- **Native Windows notification** when app is in background
- Toast shows tab name and duration (e.g. "BbcChats - Claude finished after 73s")
- Toast disappears after 5 seconds or click to dismiss

### Browser Tab
- Full web browser with **URL bar**, **back/forward/reload** buttons
- Tab title updates from page title
- URL persists across restart
- Panel stays alive when switching tabs (no refresh)

### Appearance
- **Themes** — Windows Terminal (default), VS Code Dark, PowerShell Blue (View → Theme)
- Theme affects terminal colors, font, and background
- Tab colors — right-click tab → Appearance → 10 pastel colors
- Tab colors persist per project directory (same project = same color)

### Multi-Window & Singleton
- **Ctrl+N** — new empty window
- Each window has independent layout and tabs
- **Singleton** — launching app again activates existing window
- **F9** from standalone Jamat Menu routes to the running instance

## Menus

### File
- Settings, Quit

### View
- Toggle Sidebar (Ctrl+B), Toggle Panel Bar (Ctrl+G), Maximize Panel (F11)
- Session History (Ctrl+H), File Changes (Ctrl+J), Search Sessions… (Ctrl+Shift+F), Ideas (Ctrl+I)
- Theme → Windows Terminal / VS Code Dark / PowerShell Blue
- Help (F1)

### Tab
- New Claude Tab (Ctrl+T), New Tab… (Ctrl+Shift+T), Close Tab (Ctrl+W)
- Move Right / Left / Up / Down (Alt+T chord), Reset Layout

### Window
- New Window (Ctrl+N), list of named windows (A→Z)
- Window Group Settings…, Clear Window Name (when window is named)

## Configuration

Everything is editable in **Settings** (the first launch opens a guided wizard). Config + state live in one **config-dir** (default \`~/.jamat\`), selectable with \`bin/start.bat [config-dir]\`.

| Thing | Purpose |
|------|---------|
| \`<config-dir>/config.json\` | App config — categories, paths, defaultAgent, customMenus, selfUpdate (update knobs only — the channel follows the runtime). Default dir \`~/.jamat\`; override with \`bin/start.bat <dir>\` (e.g. an SVN-synced dir to share across machines). |
| \`<config-dir>/update-log.jsonl\` | Persistent update log — every check, download, prompt (and every prompt SUPPRESSED, with the reason). Survives the restart an update causes; answers "why didn't it update?". |
| \`<config-dir>/config.local.json\` | Secret overlay — e.g. Claude.ai usage credentials (never committed) |
| \`bin/start.bat [config-dir]\` | Launch the app; recompiles automatically when the version changed. Empty dir → setup wizard. |
| \`npm run bump\` | Stamp the version (date+time) so launchers pick up changes |
| \`npm run compile\` | Build the standalone .exe to \`dist/win-unpacked/\` |
`

export function HelpPanel(_props: IDockviewPanelProps) {
  return (
    <div className="help-panel">
      <div className="help-content" dangerouslySetInnerHTML={{ __html: marked.parse(HELP_CONTENT) as string }} />
    </div>
  )
}
