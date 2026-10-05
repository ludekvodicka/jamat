# Automation presentation CLI

Run `node <this-skill>/scripts/session-automation-groups.mjs` with:

```text
describe --state STATE [--active-color COLOR]
apply --self --state STATE [--active-color COLOR] [--note-file PATH | --note TEXT]
apply --session-id UUID --config-identity UUID --channel development|production --state STATE
```

`describe` calculates the initial presentation without contacting Jamat. `apply` verifies the
controller, resolves the exact Jamat session UUID, updates differing fields and reads them back.
`--self` requires `JAMAT_V3_SESSION_ID`, `JAMAT_V3_SESSION_CONTROLLER` and
`JAMAT_V3_SESSION_CHANNEL` from the originating session. It refuses overriding its controller.
Explicit targets require the controller pair, either as arguments or from that same environment.
Never substitute the native Claude/Codex thread ID, a session title or the first listed match.

| State | Group | Color |
|---|---|---|
| working | automation | Caller active color, default blue |
| waiting | waiting | orange |
| blocked | blocked | red |
| completed | completed | green |

All states are explicit assertions by the caller. The helper never scans transcripts or guesses
task outcomes. The caller retains its own completion/review evidence and pass identity.

Stdout is one JSON envelope: `{ "ok": true, "value": ... }` with exit 0, or
`{ "ok": false, "error": { "code": "automation-groups", "detail": "..." } }` with exit 2.
Success returns group/color, applied state/session and the changed field names. Repeating a
transition skips correct fields. It does not create a watcher or durable task-state file.

Calls use the adjacent installed `appjamat-v3` adapter. Script consumers may pass `--jamat-cli PATH`
to the already resolved installed wrapper; tests can supply their CLI stub there. No private Host
endpoint or runtime descriptor is accessed.

Jamat groups are user-configurable. A removed group is reported as a failure; no alternative is
silently selected or created. Group/color/note are separate public operations: a failure may be
partial. The error includes confirmed changed fields and a read-back when available. Reconcile by
reapplying the current verified state. Never claim that a failed or unverified move succeeded.

Notes are at most 4000 characters. Missing note means preserve; an explicit empty note clears it.
Changing presentation never ends a process, closes a tab, commits files or deletes a worktree.
