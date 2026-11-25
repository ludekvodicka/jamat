# Automation state CLI

Run `node <this-skill>/scripts/session-automation-groups.mjs` with:

```text
describe --state STATE [--active-color COLOR]
apply --self --state STATE [--active-color COLOR] [--note-file PATH | --note TEXT]
apply --session-id UUID --config-identity UUID --channel development|production --state STATE
```

`apply` verifies the controller, resolves the exact Jamat session UUID, writes `automationState`
through `sessions automation --state` and, when given, the note through `sessions note`, then reads
both back. It never writes the session's group or color. `describe` answers `{ state, color }`
without contacting Jamat, where `color` is the active color.
`--self` requires `JAMAT_V3_SESSION_ID`, `JAMAT_V3_SESSION_CONTROLLER` and
`JAMAT_V3_SESSION_CHANNEL` from the originating session. It refuses overriding its controller.
Explicit targets require the controller pair, either as arguments or from that same environment.
Never substitute the native Claude/Codex thread ID, a session title or the first listed match.

| State | Chip |
|---|---|
| working | auto |
| waiting | wait |
| blocked | block |
| completed | done |

The chip is an outlined label in the session row. The session stays in its project and parent
nesting, and its row color does not change. `describe` answers the `--active-color` (default blue)
as `color` for every state.

All states are explicit assertions by the caller. The helper never scans transcripts or guesses
task outcomes. The caller retains its own completion/review evidence and pass identity.

Stdout is one JSON envelope: `{ "ok": true, "value": ... }` with exit 0, or
`{ "ok": false, "error": { "code": "automation-groups", "detail": "..." } }` with exit 2.
Success returns the session, the applied state, `automationState`, the note when given and the
changed field names (`automationState`, `note`). Repeating a
transition skips correct fields. It does not create a watcher or durable task-state file.

Calls use the adjacent installed `appjamat-v3` adapter. Script consumers may pass `--jamat-cli PATH`
to the already resolved installed wrapper; tests can supply their CLI stub there. No private Host
endpoint or runtime descriptor is accessed.

State and note are separate public operations, written in that order: a controller without
`sessions.automation` fails before the note is replaced, and a later note failure is partial. The
error names `failedField`, the confirmed changed fields and a read-back when available. Reconcile by
reapplying the current verified state. Never claim that a failed or unverified write succeeded.

Notes are trimmed, as Jamat stores them, and at most 4000 characters. Missing note means preserve; an explicit empty note clears it.
Changing the state never ends a process, closes a tab, commits files or deletes a worktree.
