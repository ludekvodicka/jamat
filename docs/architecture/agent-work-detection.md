# Agent work detection

Jamat classifies every live terminal independently as `idle`, `running`, `tool-use`, `blocked`,
`waiting`, or transient `done`. Provider-specific TUI semantics live behind separate detector
classes; React and xterm only supply frames and consume reports.

## Decision

The renderer uses three classes:

| Class | Responsibility |
|---|---|
| `AgentWorkDetectorBase` | Status lifecycle, timers, ANSI normalization, raw/screen precedence, reset, exit, disposal, and generic evidence reports. |
| `AgentWorkDetectorClaude` | Claude busy rows, spinner, tool calls, permission/question prompts, and background-shell footer. |
| `AgentWorkDetectorCodex` | Codex `Working` row and conservative activity fallback. |

`core/agents/renderer.ts` exposes `RendererAgent.createWorkDetector()`. Every terminal receives a new
instance. `AgentAdapter` does not carry TUI patterns because the filesystem/launcher adapter is not
the renderer runtime and must not share detector state between terminals.

## Data flow

```text
PTY bytes ───────────────┐
                        ├─> useTerminal frame ─> active provider detector
xterm current screen ───┘                          │
                                                   ├─> terminalStatus + events
                                                   ├─> background-shell state
                                                   └─> AgentWorkReport debug snapshot
```

An `AgentWorkFrame` contains:

- the recent raw PTY tail;
- the current bottom eight rendered rows;
- the current bottom sixteen rendered rows for high-specificity deep signals;
- terminal phase (`menu` or `running`);
- capture timestamp.

The hook invokes the detector immediately for new PTY output and again from xterm's write callback,
after the bytes have changed the rendered buffer. A screen-managed terminal resets its detector in
the menu phase. When its selected agent changes, the old detector is reset and disposed and the
renderer factory creates the new provider instance without remounting the PTY.

## Evidence precedence

Positive and negative evidence use different sources:

- New raw output may assert work immediately.
- The current rendered screen may assert work and is resilient to cursor-addressed differential
  redraws.
- A settled idle decision never trusts raw history. Raw tails retain earlier busy rows after the
  visible screen has returned to its prompt.
- `unknown` means insufficient evidence, not idle. It preserves an active state until the
  conservative fallback expires.
- Menu frames always reset to idle and never count as agent work.
- Process exit cancels pending timers, clears background activity, emits `done`, then returns to
  `idle` after three seconds.

`AgentWorkEvidence` records `{ source, signal, match }`. The status-bar diagnostic renders the exact
`AgentWorkReport` produced by the detector; it does not run a second Claude-only classifier.

## Shared timing

| Timer | Duration | Meaning |
|---|---:|---|
| Fast idle | 1.2 s | A provider has explicit settled idle evidence. Claude currently uses it. |
| Silence fallback | 15 s | Reinspect the current screen after no new output; `unknown` then settles idle. |
| Tool expiry | 3 s | Claude `tool-use` returns to `running` if no newer state supersedes it. |
| Process done | 3 s | Transient `done` indicator after PTY exit. |

The scheduler is injectable, so smoke tests advance these transitions without wall-clock waits.

## Claude rules

Claude preserves the established behavior:

- whitespace-collapsed `esc to interrupt`, token-counter, elapsed-dot, and elapsed-ellipsis signals;
- the space-preserved cycling spinner glyph plus one-word ellipsis structure;
- a deeper-screen scan only for the high-specificity elapsed forms;
- immediate `tool-use`, `blocked`, and `waiting` states from their native TUI rows;
- background shell count as orthogonal activity that does not make an idle agent `running`;
- fast idle only after the settled screen has no Claude busy signal.

The settled inspection ignores stale raw busy/tool text. Blocked and question prompts retain their
existing raw-tail behavior.

## Codex rules

The first verified Codex 0.144.4 active layout is:

```text
› Working (14m 34s • esc to interrupt)
```

`AgentWorkDetectorCodex` requires the full status-row structure: leading prompt glyph, `Working`, a
duration, the bullet separator, and `esc to interrupt`. It does not match a loose `working` word in
conversation output.

Codex has two positive signals:

- `workingRow` from raw or current rendered screen. This keeps long quiet work active beyond the
  15-second fallback.
- `outputActivity` for other new, non-empty PTY output. This preserves activity during Codex phases
  whose stable status row has not yet been captured, but it cannot keep a settled screen active by
  itself.

Missing `Working` on a rendered frame is `unknown`. There is no fixture-verified explicit Codex idle
layout yet, so Codex does not use the 1.2-second fast-idle edge. It settles after 15 seconds without
current `workingRow` evidence. Approval, waiting, tool, and alternate-active labels remain generic
`running` until a high-specificity live capture exists; no Claude wording is guessed for Codex.

## Fixtures and upstream changes

Provider fixtures are stored at:

- `core/agents/claude/fixtures/work-detection.json`;
- `core/agents/codex/fixtures/work-detection.json`.

`scripts/smoke-agent-work-detection.ts` covers provider evidence, stale raw history, timing, menu
reset, process exit, and disposal. `WorkDetectionStatus.test.tsx` verifies that the UI renders generic
Claude/Codex reports and only flags contradictions for known verdicts.

When an upstream TUI changes:

1. capture sanitized raw and rendered tails from the diagnostic;
2. retain layout/control sequences but remove prompts, paths, ids, account data, and instructions;
3. add positive and collision-negative fixture cases;
4. change only that provider detector;
5. run the focused smoke, Electron component test, typecheck, and full suites.

Do not add broad text matches from screenshots alone. If a phase has no stable rendered invariant,
keep it as generic activity or revisit the runtime source rather than treating absence as idle.

## Entry points

- `core/agents/workDetection/agentWorkDetectorBase.ts`
- `core/agents/workDetection/agentWorkDetector.types.ts`
- `core/agents/claude/agentWorkDetectorClaude.ts`
- `core/agents/codex/agentWorkDetectorCodex.ts`
- `core/agents/renderer.ts`
- `app-electron/src/renderer/hooks/useTerminal.ts`
- `app-electron/src/renderer/components/WorkDetectionStatus.tsx`
