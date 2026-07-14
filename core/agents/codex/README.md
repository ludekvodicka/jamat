# CodexAdapter — Codex CLI backend

Schema + CLI reference for the Codex (OpenAI GPT) backend, **verified live** on
2026-07-10 against **`codex-cli 0.144.1`** (Windows, `~/.codex/`). The verification
items from `.aidocs/architecture/codex-portability-assessment.md` are answered below;
`fixtures/` holds neutral, schema-faithful captures the U3/U4 parsers are written against.

Status: `AgentAdapterBase`-derived. Discovery/parse land in U3, CLI/exec in U4 (they
throw today). Every degrade member (rename, active-pids, effort) is inherited from the base.

## Filesystem layout

- **Sessions root:** `~/.codex/sessions/YYYY/MM/DD/rollout-<TS>-<UUID>.jsonl`
  (date tree, NOT keyed by project dir). One file per session.
  Filename `rollout-2026-07-10T14-19-12-019f4bf7-b5d8-74b0-9175-a5a5938a4082.jsonl` =
  `rollout-<start-ts>-<sessionId>.jsonl`.
- **Auth:** `~/.codex/auth.json` (present when logged in). Config: `~/.codex/config.toml`
  (`model`, `model_reasoning_effort`, `sandbox`, per-project `[projects.'<path>']` blocks).
- **Scale note:** a heavy user's tree had **25,189** rollout files — the U3 walker MUST be
  incremental (per-day-dir mtime cache; header-line reads only), never a full re-parse.

## Rollout JSONL schema

Every line is `{ "timestamp": ISO, "type": <record-type>, "payload": {...} }`.

Record `type` values (one real session): `session_meta` (1, the header), `turn_context`,
`world_state`, `response_item` (the conversation items), `event_msg` (streaming/status events).

### `session_meta` — the header (first line)
`payload` carries what discovery needs:
- `session_id` (== `id`) — the sessionId. **UUIDv7** (`019f4bf7-b5d8-74b0-9175-a5a5938a4082`);
  matches the existing `SESSION_ID_RE` (hex 8-4-4-4-12), so **no regex change needed**.
- **`cwd`** — the session's project dir. THIS is the discovery key (there is no encoded path).
- `timestamp` — session start.
- `cli_version`, `originator` (`codex-tui`), `model_provider` (`openai`), `history_mode`.
- `base_instructions.text` — OpenAI's full system prompt (~8 KB). Irrelevant to us; **redacted in the fixture** (do NOT commit real ones — this repo is public).

### `response_item` — conversation items (`payload.type`)
- `message` — `{ role: 'user'|'assistant'|'developer', content: [{ type: 'input_text'|'output_text', text }] }`.
  The **final assistant message** = last `message` with `role:'assistant'` → `content[].text` (session preview + title source).
- `reasoning` — model reasoning (skip for turns/preview).
- `custom_tool_call` — `{ name: 'exec', call_id, input }`. In 0.144.1 file edits go through the
  `exec` tool; `input` is a JS snippet, e.g. `const r = await tools.apply_patch("*** Begin Patch\n*** Add File: hello.txt\n+hi\n*** End Patch"); text(r);`.
- `custom_tool_call_output` — `{ call_id, output }` (tool result).
- `function_call` / `function_call_output` — other tools (e.g. `shell`, `wait`).

### `event_msg` — status/streaming events (`payload.type`)
- **`patch_apply_end`** — the CLEAN file-edit signal: `{ call_id, stdout, success, changes: { "<abs-path>": {...} } }`.
  → `extractEditedFiles` = union of `Object.keys(payload.changes)` over all `patch_apply_end` with `success:true`.
  → `hasFileEdits` = any such event. (Preferred over parsing the `apply_patch` envelope text.)
- **`token_count`** — usage + context, LOCAL (see below).
- `agent_message` / `user_message`, `task_started` / `task_complete`, `web_search_end`, `patch_apply_begin`.

## `token_count` — usage AND context, read LOCALLY (no OpenAI API)

`payload` (verified):
```
info: {
  total_token_usage:  { input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens },
  last_token_usage:   { ...same shape... },
  model_context_window: 400000
},
rate_limits: {
  limit_id: "codex",
  primary:   { used_percent, window_minutes: 300,   resets_at: <unix-s> },   // ~5-hour window
  secondary: { used_percent, window_minutes: 10080, resets_at: <unix-s> },   // ~weekly window
  plan_type: "prolite", credits, rate_limit_reached_type
}
```
**Big consequence for U6:** the usage panel does NOT need the OpenAI billing API / an
API key. The latest `token_count.rate_limits` from the newest rollout gives the 5h + weekly
`used_percent` + `resets_at` + `plan_type` directly. Recommended `usageSource` = read local
rollout (revisit the `'openai'` capability value + the planned `openaiUsage` API-key config in U6).
**Context % (U6/gap):** feasible — `last_token_usage.total_tokens / model_context_window`.
So `capabilities.contextPercent` CAN flip true for Codex once `readSessionModelInfo` reads it.

## `codex exec --json` — one-shot event stream (AI-commit path)

Different, cleaner schema than the rollout — top-level `{ type, ... }` per line:
`thread.started` (`thread_id`) → `turn.started` → `item.started`/`item.completed`
(`item: { type: 'agent_message'|'file_change'|..., text? }`) → `turn.completed` (`usage`).
- **`parseExecOutput`** = last `item.completed` with `item.type === 'agent_message'` → `item.text`.
- File edits surface as `item.type: 'file_change'`.
- **stdin:** `codex exec [PROMPT]` — if stdin is piped AND a prompt arg is given, stdin is
  appended as a `<stdin>` block. So AI-commit pipes the diff on stdin + prompt as the arg.
- Alternative to NDJSON parsing: `-o/--output-last-message <FILE>` writes the final message
  straight to a file. `--ephemeral` skips persisting a session (maps to `ExecOptions.ephemeral`).

## CLI flags (verified) — for U4

- Launch: `codex` (interactive). Resume: `codex resume <SESSION_ID>` / `codex resume --last`.
- Exec: `codex exec [--json] [-m MODEL] [-C DIR] [--skip-git-repo-check] [--ephemeral] [-o FILE] [PROMPT]`.
- Sandbox/perms: `-s/--sandbox read-only|workspace-write|danger-full-access`,
  `--dangerously-bypass-approvals-and-sandbox` (maps to our `skipPermissions`).
- **Directory-trust gate** (separate from approvals/sandbox): on first launch in an untrusted cwd,
  Codex prompts *"Do you trust the contents of this directory?"* and, on yes, records
  `[projects.'<cwd>'] trust_level = "trusted"` in `config.toml`. `--dangerously-bypass-...` does NOT
  suppress it. `trust.ts` (`ensureCodexProjectTrust`) pre-seeds that block before launch — the analog
  of `claude/trust.ts` — so a Jamat-launched Codex starts without the prompt.
- **Fork:** `codex fork <id>` / `codex fork --last` — WIRED (`capabilities.fork = true`). `resume-fork`
  maps to `codex fork <id>`. Restart-safety does NOT use live pids (Codex has none): the launched
  session is resolved by cwd + mtime (`resolveCodexLaunchedSession`) so the executor rewrites
  `resume-fork` → `resume <newForkId>` and a restart resumes the fork instead of re-forking the parent.
  Same resolver also fills in a new `cc` session's id (unlocks Rename / exact-resume for Codex).
- Model: `gpt-5.6-sol` (the installed default; `model_reasoning_effort = "xhigh"`). Populate
  `capabilities.execModels` in U8 from the account's available ids.

## Windows specifics

- Binary is a **`.cmd` shim** (`codex.cmd` on PATH) — spawn may need the `.cmd` name explicitly
  (cf. the historical `code.cmd` gotcha). `listAvailableAgents()` already probes PATHEXT.
- **cwd casing / 8.3 short names:** `session_meta.cwd` can be a long path (`C:\Users\jane.doe`)
  OR an 8.3 short form (`C:\Users\JANE~1.DOE\...\scratchpad\...`) depending on how Codex was
  launched. The U3 cwd index MUST normalize case-insensitively and tolerate short/long-name
  mismatch (e.g. compare `fs.realpathSync.native` or fold both) or a project's Codex sessions
  won't match its real dir.

## Verification checklist (assessment §"Open verification items") — ANSWERED

- [x] Sessions tree = `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`; cwd in the `session_meta` header. **Confirmed.**
- [x] JSONL record shapes + `tool_use` analog — `custom_tool_call name:'exec'` w/ `apply_patch`; edits via `patch_apply_end.changes`. **Confirmed (fixtures).**
- [x] `codex exec --json` reducible to the final message — last `agent_message` item. **Confirmed (fixtures).**
- [x] exec stdin acceptance — piped stdin appended as `<stdin>` when a prompt arg is present. **Confirmed (`--help`).**
- [x] Session-id format vs `SESSION_ID_RE` — UUIDv7, matches. **No change needed.**
- [x] Windows binary shape — `codex.cmd` shim on PATH. **Confirmed.**
- [x] Auth/credential file — `~/.codex/auth.json`. **Confirmed** (drives `AgentDockerSpec.credentialFile`).
- [x] Usage/context source — LOCAL `token_count.rate_limits` + `model_context_window`; no OpenAI API. **Confirmed** (reshapes U6).
- [~] `custom-title` tolerance — **NOT tested.** Kept `appendCustomTitle` = false (base default); rename degrades to a toast. Revisit only if durable Codex rename is wanted.
- [~] **TUI markers (tool glyph / approval prompt / busy line) — NOT captured.** Needs an interactive PTY session (exec is non-interactive). `CODEX_TTY_PATTERNS` stays minimal → the turn indicator falls back to the 15s silence timer (upstream-agnostic, per plan). Follow-up: capture a real `codex` TUI transcript and fill `toolUse`/`blocked`/`busy`.

## Fixtures

- `fixtures/rollout-sample.jsonl` — neutral session: header (`cwd:/work/demo-project`), user +
  assistant messages, an `exec`/`apply_patch` file edit + `patch_apply_end` (changes → `hello.txt`),
  a `token_count` with `rate_limits`, final assistant message. Base-instructions redacted.
- `fixtures/exec-stream.ndjson` — a `codex exec --json` stream ending in the final `agent_message`.

Both are hand-built to mirror the live 0.144.1 schema (real captures were kept out of the repo:
they carry the user's cwd/username and OpenAI's system prompt). Re-run the spike on a Codex upgrade.
