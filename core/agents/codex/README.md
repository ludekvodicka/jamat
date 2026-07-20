# CodexAdapter — Codex CLI backend

Schema + CLI reference for the Codex (OpenAI GPT) backend, **verified live** on
2026-07-10 against **`codex-cli 0.144.1`**, with naming and session-runtime fields re-verified on
2026-07-14 against **`codex-cli 0.144.4`** (Windows, `~/.codex/`). The verification
items from `.aidocs/architecture/codex-portability-assessment.md` are answered below;
`fixtures/` holds neutral, schema-faithful captures the U3/U4 parsers are written against.

Status: `AgentAdapterBase`-derived with discovery, parsing, launch/exec, durable session names,
native live rename, and model/effort/context runtime status implemented. Active-pids still use base
degradation.

## Filesystem layout

- **Sessions root:** `~/.codex/sessions/YYYY/MM/DD/rollout-<TS>-<UUID>.jsonl`
  (date tree, NOT keyed by project dir). One file per session.
  Filename `rollout-2026-07-10T14-19-12-019f4bf7-b5d8-74b0-9175-a5a5938a4082.jsonl` =
  `rollout-<start-ts>-<sessionId>.jsonl`.
- **Auth:** `~/.codex/auth.json` (present when logged in). Config: `~/.codex/config.toml`
  (`model`, `model_reasoning_effort`, `sandbox`, per-project `[projects.'<path>']` blocks).
- **Session names:** `~/.codex/session_index.jsonl`, append-only rows shaped
  `{id,thread_name,updated_at}`. The latest valid row per session ID wins. It is separate from the
  rollout and shared by all projects.
- **Scale note:** a heavy user's tree had **25,189** rollout files — the U3 walker MUST be
  incremental (per-day-dir mtime cache; header-line reads only), never a full re-parse.

## Rollout JSONL schema

Every line is `{ "timestamp": ISO, "type": <record-type>, "payload": {...} }`.

Record `type` values (one real session): `session_meta` (1, the header), `turn_context`,
`world_state`, `response_item` (the conversation items), `event_msg` (streaming/status events).

### `turn_context` — effective per-turn settings

Current 0.144.4 rows carry the effective `model` and `effort` after config/profile/CLI/TUI
overrides. Older observed shapes use `reasoning_effort` or
`collaboration_mode.settings.reasoning_effort`; the runtime parser accepts all three. A new
`turn_context` becomes visible only after its following valid `token_count`, so Jamat never combines
new settings with an older turn's context size.

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
  The **final assistant message** = last `message` with `role:'assistant'` → `content[].text` (session preview source).
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

### Human user-message normalization

Current rollouts can store generated `# AGENTS.md instructions … <INSTRUCTIONS>…` content as a
`response_item/message/role:user` before the actual prompt. The generated record and the real prompt
can share one `turn_id`, so taking the first user-role response produces identical, misleading
session titles.

For `firstUserMessage`, `sessions.ts` prefers the first `event_msg/user_message`, whose `message`
contains the clean human prompt. It retains the first non-synthetic user `response_item` as a legacy
fallback and commits to that fallback at the first agent output, so a later event added after a CLI
upgrade cannot retitle an old resumed session. A following `task_started` is also a boundary for an
interrupted first turn with no output. Preview and turn extraction continue to use ordered conversation
items but share the same synthetic filter. The filter excludes:

- `<environment_context>…`;
- `<user_instructions>…`;
- generated `# AGENTS.md instructions …` records that also contain the `<INSTRUCTIONS>` envelope.

A session with no human prompt returns `firstUserMessage:null`; the UI then uses the session UUID.
Rows are never deduplicated by title because independently resumable sessions may legitimately have
the same prompt.

## `token_count` — usage AND context, read LOCALLY (no OpenAI API)

`payload` (verified):
```
info: {
  total_token_usage:  { input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens },
  last_token_usage:   { ...same shape... },
  model_context_window: 258400
},
rate_limits: {
  limit_id: "codex",
  primary:   { used_percent, window_minutes: 300,   resets_at: <unix-s> },   // ~5-hour window
  secondary: { used_percent, window_minutes: 10080, resets_at: <unix-s> },   // ~weekly window
  plan_type: "prolite", credits, rate_limit_reached_type
}
```
The context window is provider-reported and has changed between versions/sessions (the older fixture
used 400,000; current sessions report 258,400), so Jamat never hardcodes it. Runtime occupancy is
`last_token_usage.total_tokens / model_context_window`; cached tokens are already represented by
`total_tokens` and are not added again. `SessionRuntime` pairs this record with its preceding
`turn_context`, cold-reads a bounded tail with one full fallback, then parses only appended bytes.

Account rate limits use the Codex app-server, not rollout discovery; they remain a separate status
item from this session-specific model/context contract.

## Account rate limits — Codex app-server

Codex 0.144.4 exposes stable `account/rateLimits/read` and
`account/rateLimits/updated` methods through `codex app-server`. They use the existing Codex login;
Jamat needs no OpenAI API key and writes no Codex credentials.

Jamat prefers the exact `rateLimitsByLimitId.codex` snapshot and falls back to the compatibility
`rateLimits` field. It maps both `primary` and `secondary` by their declared
`windowDurationMins`: 300 minutes is the status bar's `S` window and 10080 minutes is `W`.
Primary/secondary order is not semantic. A verified current response carries only the weekly window
in `primary`, while older rollouts carried 5h in `primary` and weekly in `secondary`.

The main process reads immediately when a running Codex tab becomes active, listens for app-server
notifications, and refreshes once per minute while Codex remains active. Missing windows remain
missing rather than becoming 0%; a weekly-only response therefore renders only `W`.

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
- Model: current sessions report values such as `gpt-5.6-sol` with effort `max`. Populate
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
- [x] Session model/effort/context source — LOCAL paired `turn_context` + `token_count`; no OpenAI API. **Confirmed on 0.144.4.**
- [x] Session naming — `/rename <name>` is supported; names persist in append-only
  `session_index.jsonl`, latest row wins. Jamat reads, watches, and appends that native shape and
  pipes the slash command so Codex updates its own live metadata. **Confirmed on 0.144.4.**
- [x] Active TUI row — `› Working (<elapsed> • esc to interrupt)` captured from a live 0.144.4
  terminal and implemented structurally in `AgentWorkDetectorCodex`. It sustains long work beyond
  the 15-second fallback; non-Working output emits generic `outputActivity`.
- [ ] Explicit idle, tool, and approval/waiting layouts — not yet captured. Missing `Working` is
  `unknown`, so Codex settles conservatively after 15 seconds and does not guess Claude states.

## Fixtures

- `fixtures/rollout-sample.jsonl` — neutral session: header (`cwd:/work/demo-project`), current
  model/effort fields, user + assistant messages, an `exec`/`apply_patch` file edit +
  `patch_apply_end` (changes → `hello.txt`), and multiple context snapshots. Base-instructions redacted.
- `fixtures/exec-stream.ndjson` — a `codex exec --json` stream ending in the final `agent_message`.
- `fixtures/work-detection.json` — sanitized renderer frames for the verified `Working` row,
  unknown idle/prose layouts, menu reset, and duration variants.

The rollout and exec fixtures are hand-built to mirror the live 0.144.1 schema. The work-detection
fixture mirrors the live 0.144.4 screenshot. Real captures stay out of the repo because they carry
the user's cwd/username and OpenAI's system prompt. Re-run the spike on a Codex upgrade.
