# CodexAdapter — Stub

This directory contains a **stub** implementation of `AgentAdapter` for the
Codex (GPT-5.5-class) CLI backend. Today every spawn-path method throws
`Error('codex backend not yet implemented')`; non-spawn methods return
graceful no-op values (`false`, `null`, `[]`).

The stub exists so the universal adapter abstraction has two consumers
(real + stub) instead of one. That guarantees the interface compiles
against more than just the historical Claude implementation and surfaces
shape mistakes early.

## When this stub is selected

- The renderer's TabTypePicker greys out the "Codex" entry when the
  `codex` binary is not on PATH (or when a future selector decides Codex
  isn't available). Clicking the disabled entry shows a toast.
- If Codex *is* on PATH but the stub is still in place, picking it from
  any spawn path (CLI menu, TabPicker, AI commit) throws the documented
  error. The error surfaces as a clean toast / log line rather than an
  unhandled rejection.
- Methods that legitimately don't apply (`appendCustomTitle` → false,
  `renameSlashCommand` → null, `permissionConfigPaths` → []) return
  graceful values so panels that walk both adapters in turn (Recent
  Files, Sessions Search, …) keep working.

## Before this can ship for real

See `docs/architecture/codex-portability-assessment.md` — the
"Open verification items" section lists what needs hands-on Codex
verification before each interface method can be filled in. In short:

1. **Capture a Codex session transcript** to confirm the JSONL field
   names and `tool_use` block shape (§3 of the assessment).
2. **Observe Codex's TUI** with the actual `codex` binary running to
   capture the `toolUse` marker regex and the `blocked` prompt set
   (§5). Today's placeholder regex (`/(?!.*)/`) never matches.
3. **Confirm CLI flag set** — resume, fork, model selection, `-p`
   one-shot mode (§4). The buildLaunchCommand / buildExecCommand
   methods are written to throw until a real flag set is verified.
4. **Decide `appendCustomTitle` behavior** — does Codex's parser
   tolerate unknown JSONL record types? If not, return `false` from
   the real impl too (the rename UI falls back to the in-app cache).
5. **Confirm sessions tree** — `~/.codex/sessions/<YYYY>/<MM>/<DD>/`
   per the assessment, but verify on a fresh Codex install.

## Implementation order suggestion

When you're ready to flesh this out:

1. Start with §1 (filesystem) and §2 (discovery) — pure IO, lowest risk.
2. Then §3 (JSONL parsing). Add a new smoke `scripts/smoke-codex-adapter.ts`
   modeled on `smoke-agents-registry.ts`'s Claude section, fed by a real
   captured transcript.
3. §5 (TUI patterns) requires hands-on observation; lift the regex set
   from `core/agents/claude/patterns.ts` as a template.
4. §4 (CLI invocation) last — it's the most risky (spawn surface) and
   benefits from having §1–§3 working so you can resume sessions you
   created during testing.
