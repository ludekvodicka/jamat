# Codex session message selection

## Decision

Codex session titles represent the first human prompt, not the first transcript record whose role is
`user`.

For current rollout files, `core/agents/codex/sessions.ts` uses
`event_msg` with `payload.type === "user_message"` as the authoritative title source. That event
contains the clean submitted prompt, including `[Image #n]` placeholders but excluding transport
markup and generated project instructions.

Older rollouts may contain only `response_item` conversation records. While scanning the first turn,
the parser therefore retains the first non-synthetic user response as a fallback. It returns that
fallback when agent output or a following task starts, or when the file ends.

## Synthetic user records

Codex and its launch surface can serialize instruction/context records with `role:"user"`. The
shared `isInjectedUserContext()` predicate excludes three shapes from titles, previews, and turns:

- `<environment_context>…`;
- `<user_instructions>…`;
- a generated heading `# AGENTS.md instructions` or `# AGENTS.md instructions for <path>` followed
  by an `<INSTRUCTIONS>` envelope.

The heading alone is insufficient for classification; requiring `<INSTRUCTIONS>` avoids hiding an
ordinary user prompt that merely discusses AGENTS instructions.

If a rollout contains no human prompt, `firstUserMessage` is `null` and the existing session picker
falls back to the session UUID.

## Data flow

1. `CodexSessionIndex` discovers rollout files by date tree and filters them by header `cwd`.
2. `listCodexSessionsForProject()` calls `readFirstUserMessage()` for each matching rollout.
3. `core/menu-core/transitions.ts` merges Claude and Codex session objects without title-based
   deduplication and sorts them by `lastActivity`.
4. `app-cli/render.ts` displays `slug`, then `firstUserMessage`, then the session UUID.

Preview (`loadCodexSessionPreview`) and Session Changes turns (`extractCodexTurns`) preserve ordered
`response_item` content but apply the same synthetic predicate, so generated instructions cannot
reappear through a secondary UI.

## Constraints

- Never deduplicate sessions by title; separate UUIDs are separate resumable sessions.
- Keep the response-item fallback for rollout schema compatibility.
- Stop waiting for an explicit event after the first agent output or a following task boundary. A
  session resumed across a Codex CLI schema upgrade may gain newer event records, which must not
  replace its original title.
- Keep the generated-wrapper test schema-faithful but neutral; real rollout files contain local paths
  and instruction content and must not be committed.

## Verification

`scripts/smoke-codex-sessions.ts` covers current event-based selection, legacy fallback, synthetic
filtering in preview and turns, and a synthetic-only rollout. A live check against the five reported
sessions of one project confirms five unique UUIDs now produce five real prompts.
