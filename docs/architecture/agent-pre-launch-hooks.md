# Per-agent pre-launch hooks

Config-driven commands that run in a project folder **before an agent instance is created there**.
The motivating case (SvnTea `nodejs/AppJamat#1`) is the **Codex AGENTS.md packer**: Codex cannot
resolve our `CLAUDE.md` `@`-imports or walk the directory-group `CLAUDE.md` above the git root, so
before a Codex session starts we flatten our rule cascade into a Codex-native `<dir>/AGENTS.md`
(`node ~/.claude/extensions/codex/CLI/packer.mjs build --dir <P>`).

## Why config-driven (not hardcoded)

AppJamat has a public GitHub mirror. Hardcoding the packer call would force our internal tooling on
every public clone. Instead the hook is a **config field** (`AppConfig.agents.<id>.preLaunch`):

- The committed public `configs/config.example.json` ships it **off** (documented, inert) → a clone
  runs Codex unchanged.
- A private, git-ignored `.private/configs/<user>/config.json` sets `agents.codex.preLaunch` to the
  packer → the hook is active only there, and never reaches the public repo (`.private/` is git-ignored).

## Shape

```jsonc
"agents": {
  "codex": {
    "preLaunch": {
      "command": "node",
      "args": ["~/.claude/extensions/codex/CLI/packer.mjs", "build", "--dir", "{dir}"],
      "cwd": "{dir}",        // optional; default = the project dir being launched
      "timeoutMs": 20000     // optional; default 20000
    }
  }
}
```

`{dir}` (absolute project path) and `{name}` (folder name) are substituted in `args`/`cwd`; a leading
`~` expands to the home dir — same conventions as `customMenus`, so a value stays portable across our
machines. Types: `AgentPreLaunch` (beside `LaunchConfig` in `core/types/contracts.ts`, to avoid a
config↔contracts import cycle), `AgentSettings` / `AgentsConfig` (`core/types/config.ts`).

## Where it runs — the single choke point

`core/executor/agent-launcher.ts` `buildLaunchCommand` is the one agent-agnostic function every entry
point (electron / cli / agent) calls to build a launch. It runs the hook there — **after** the
adapter builds the command (so a refused launch — Docker isolation, a bad session id — skips it) and
**before** the caller spawns. The runner is `core/executor/pre-launch.ts`:

- `resolveAgentPreLaunch(agents, agentId)` — the caller looks up the hook from its already-loaded
  `AppConfig` and passes it on `LaunchConfig.preLaunch` (electron: `getAppConfig()`; agent-server:
  its `appConfig`; cli: a best-effort `loadConfig`).
- `runAgentPreLaunch(hook, selection)` — expands `~`, substitutes `{dir}`/`{name}`, spawns via
  `shellWrapArgv` (so `node` / `.cmd` shims resolve like every other Jamat spawn), and returns
  `ok` / `skipped` / `failed`.

Scope is **interactive session/tab launches** only — not the short-lived `codex exec` AI-commit path
(a one-shot where startup speed matters and project conventions barely apply).

## Non-fatal by contract

`runAgentPreLaunch` **never throws**. A non-zero exit (e.g. the packer hard-failing outside an
`Applications*` tree), a spawn error, or a timeout returns `{status:'failed'}`; the launcher logs
`[pre-launch] …` via `console.warn` and launches the agent anyway. This satisfies the ticket
constraint: a non-`Applications*` directory (or a missing packer) never blocks a Codex launch — the
global `~/.codex/AGENTS.md` + the runtime fallback ritual still apply there.

## Relationship to `codex-run`

`codex-run` (in `ai/claude_extensions`) is a sibling wrapper that packs **and** launches Codex for CLI
/ pp use. Jamat does **not** delegate its launch to it — Jamat owns its own resume / fork / trust-seed
/ PTY machinery and must emit the exact `codex` / `codex resume` / `codex fork` invocation itself. So
Jamat integrates at the **packer choke-point** they both share (`packer.mjs build --dir`), per the
packer README which lists `jamat` as a direct caller of that command.

## UI

Settings → **Agents** tab (`SettingsPanel.tsx` `AgentsEditor`): per agent it shows an **installed
status** (● Installed / ○ Not installed / Detecting…) from the `agents:list` IPC — read-only, and the
hook's enable toggle + fields are disabled unless the agent's CLI is on PATH. When enabled: command /
args (one per line) / cwd / timeout. Persists the full `agents` object via `config:update`
(`writeConfigPatch`), validated by `validateAgents` (shared by the load + patch paths in
`core/config.ts`). No packer-specific UI ships publicly — the internal packer is configured via JSON
in our private `.private/` configs, not a button in the app.

**Agent availability** is computed main-side (`listAvailableAgents()` → binary on PATH), exposed via
the existing `agents:list` IPC, fetched once in `App.tsx` into `layout-store.agentsMeta`
(`AgentMeta[] | null`; `null` = still detecting), and read by both the Agents tab and every tab's
context menu.

**Cross-agent quick-launch:** a tab's right-click menu (`TabContextMenu`, wired from `CustomTab`)
offers **"New session in \<other agent\>"** next to "New blank session" — a fresh `cc` session in the
same folder with the other agent — shown only on a local agent tab with a project dir **when both
agents are installed**, so you can run Claude ↔ Codex side by side in one folder.

## Tests

- `scripts/smoke-pre-launch.ts` — lookup, `{dir}`/`{name}` + `~` expansion, argv/cwd/timeout
  resolution (injected `spawnSync`), the non-fatal failure contract, and a real `node` spawn.
- `scripts/smoke-config.ts` `[7]` — `agents` validation on the load + patch paths.
