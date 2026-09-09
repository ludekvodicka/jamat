import { describe, expect, it } from 'vitest'

import type { AgentWorkFrame } from './agentWorkInspector.types'
import { AgentWorkInspectorClaude } from './agentWorkInspectorClaude'
import { ScreenTail } from './screenTail'
import type { WorkFixture } from './fixtures/workFixtures'
import { WorkFixtures } from './fixtures/workFixtures'

describe('lib-orchestrator/sessionManager/workState/agentWorkInspectorClaude', () => {
  const fixtures = WorkFixtures.of('claude')

  function recorded(file: string): WorkFixture {
    const fixture = fixtures.find((candidate) => candidate.file === file)
    if (fixture === undefined) throw new Error(`missing work fixture ${file}`)
    return fixture
  }

  it('has a recorded corpus to answer over', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(10)
  })

  // The corpus this tree inherited was V1 text about a screen, never a screen, which is how the
  // marker glyph moved and the plan prompt went unnoticed while the suite stayed green. This is the
  // rule that stops that repeating: the verdicts that matter are answered over frames recorded HERE.
  //
  // The permission prompt joined the list on 2026-08-20. It had been missing because every agent on
  // this machine ran with permissions already granted; parking one with `--permission-mode manual`
  // and asking it to run a command outside the allow list produced the frame, and the frame
  // confirmed the wording V1 had shipped untested.
  it('holds frames recorded from this tree for the verdicts that matter', () => {
    for (const file of [
      'claude-live-plan-approval.json',
      'claude-live-question-menu.json',
      'claude-live-working.json',
      'claude-live-idle.json',
      'claude-live-stale-ring.json',
      'claude-live-permission-prompt.json',
      'claude-live-background-tasks.json',
      'claude-live-background-agent.json',
    ])
      expect(recorded(file).recorded, `${file} must carry recorded {build, capturedAt}`).toBeDefined()
  })

  it.each(fixtures.map((fixture) => [fixture.file, fixture] as const))(
    'classifies %s as its recorded screen says',
    (_file, fixture: WorkFixture) => {
      const inspection = AgentWorkInspectorClaude.inspect(fixture.frame)
      expect(inspection.hint).toBe(fixture.expected.hint)
    },
  )

  // Containment, not equality: the prompt pass reads three windows, so one wording on screen is
  // three pieces of evidence. What a test may pin is which signals a verdict rests on, never how
  // many windows happened to be carrying them.
  it('names the signal every verdict rests on', () => {
    const named = (file: string): string[] =>
      AgentWorkInspectorClaude.inspect(recorded(file).frame).evidence.map((item) => item.signal)
    expect(named('claude-working-spinner.json')).toContain('spinnerGlyph')
    expect(named('claude-working-wide-elapsed.json')).toContain('elapsedDot')
    // The ring is not work: this frame's busy marker is in raw only, and nothing rests on it.
    expect(named('claude-working-stale-raw.json')).toEqual([])
    expect(new Set(named('claude-tool-use.json'))).toEqual(new Set(['toolUse']))
    expect(new Set(named('claude-blocked-prompt.json'))).toEqual(new Set(['blockedPrompt']))
    expect(new Set(named('claude-question-menu.json'))).toEqual(new Set(['menuFooter']))
    expect(new Set(named('claude-live-plan-approval.json')))
      .toEqual(new Set(['blockedPrompt', 'planApproval', 'selectedYes']))
    expect(new Set(named('claude-live-background-tasks.json')))
      .toEqual(new Set(['backgroundTasks']))
  })

  // The measurement that wrote the pattern, kept as a test so nobody writes the obvious one again.
  // `· ← N agents` is drawn on every session, including one at an empty prompt with nothing behind
  // it; what actually separates the two states is the `↓ to manage` hint, and the two recorded
  // background frames carry it while the two recorded quiet ones do not.
  it('reads the footer hint that only background work draws, not the permanent agent counter', () => {
    const background = ['claude-live-background-tasks.json', 'claude-live-background-agent.json']
    const normalized = (file: string): string =>
      ScreenTail.normalizeTty(recorded(file).frame.screenTail)

    // The counter is on all three footers, background and quiet alike, which is the whole point:
    // it says nothing about what is running.
    for (const file of [...background, 'claude-live-idle.json'])
      expect(normalized(file), `${file} should carry the permanent agent counter`)
        .toMatch(/·←\d+agents?/)
    // The hint is on neither quiet frame, and the quiet frames are not background.
    for (const file of ['claude-live-idle.json', 'claude-live-permission-prompt.json']) {
      expect(normalized(file), `${file} should not carry the manage hint`).not.toMatch(/↓tomanage/)
      expect(AgentWorkInspectorClaude.inspect(recorded(file).frame).hint, file)
        .not.toBe('background')
    }
    for (const file of background) {
      expect(normalized(file), `${file} should carry the manage hint`).toMatch(/↓tomanage/)
      expect(AgentWorkInspectorClaude.inspect(recorded(file).frame).hint, file).toBe('background')
    }
  })

  // The shell counter's closing boundary, from both sides: the footer says it, a sentence about it
  // does not.
  it('counts background shells in the footer and not in a sentence about them', () => {
    expect(AgentWorkInspectorClaude.inspect(recorded('claude-background-shell.json').frame).hint)
      .toBe('background')
    const prose = AgentWorkInspectorClaude.inspect(
      recorded('claude-live-shell-prose-collision.json').frame)
    expect(prose.hint).toBe('idle')
    expect(prose.evidence).toHaveLength(0)
  })

  // R2, the invariant the reported bug came from: the prompt is on the screen, and the ring has
  // churned past it. The recorded menu keeps its verdict with its raw window replaced by repaint
  // noise, and the verdict then rests on no raw evidence at all.
  it('reads a prompt off the screen after the raw ring has churned past it', () => {
    const menu = recorded('claude-live-question-menu.json').frame
    const inspection = AgentWorkInspectorClaude.inspect({
      ...menu,
      rawTail: recorded('claude-live-idle.json').frame.rawTail,
    })
    expect(inspection.hint).toBe('waiting')
    expect(inspection.evidence.some((item) => item.source === 'raw')).toBe(false)
  })

  // The corroboration rule, from both sides. A quoted menu in the wide window and the ring is a
  // reply about a prompt; the same rows beside a footer are the prompt.
  it('keeps a selected row that a footer corroborates and drops one that nothing does', () => {
    const menu = AgentWorkInspectorClaude.inspect(recorded('claude-live-question-menu.json').frame)
    expect(menu.evidence.some((item) => item.signal === 'selectedRow'
      && item.source === 'wide-screen')).toBe(true)
    for (const file of [
      'claude-live-quoted-menu-collision.json',
      'claude-live-blockquote-collision.json',
    ]) {
      const inspection = AgentWorkInspectorClaude.inspect(recorded(file).frame)
      expect(inspection.hint, file).toBe('idle')
      expect(inspection.evidence, file).toHaveLength(0)
    }
  })

  // The reported bug, as the frame that carried it. Claude echoes a user message behind a chevron,
  // so a message opening with a numbered list puts `>1.` on the screen - the same normalized row a
  // menu draws - with the busy footer still under it. A bare row is not a menu even in the shallow
  // window, and the busy evidence beneath must be what the verdict rests on.
  it('does not read a working session as waiting off its own echoed user message', () => {
    const frame = recorded('claude-live-user-echo-collision.json').frame
    expect(ScreenTail.normalizeTty(frame.screenTail)).toMatch(/[>❯]\d+\./)
    const inspection = AgentWorkInspectorClaude.inspect(frame)
    expect(inspection.hint).toBe('working')
    expect(inspection.evidence.some((item) => item.signal === 'selectedRow')).toBe(false)
  })

  // The wide window exists for one reason: a tall input box and a rotating tip line push the elapsed
  // row out of the shallow one, and V1 watched the tab flicker idle-to-running when it was missed.
  // This recording is that screen, so the verdict must come from the wide window and nowhere else.
  it('finds an elapsed row the shallow window has already lost', () => {
    const inspection = AgentWorkInspectorClaude.inspect(recorded('claude-working-wide-elapsed.json').frame)
    expect(inspection.evidence.length).toBeGreaterThan(0)
    expect(inspection.evidence.every((item) => item.source === 'wide-screen')).toBe(true)
  })

  // A prompt that blocks the turn outranks a menu, a menu outranks a tool line, and busy evidence
  // only decides when none of them is on screen. The screens are recorded; the order is not, so it
  // is asked here over one frame carrying several of them at once.
  it('answers the blocking question first when several are true at once', () => {
    const spinner = recorded('claude-working-spinner.json').frame
    const tool = recorded('claude-tool-use.json').frame.rawTail
    // A prompt has to be ON the shallow screen to decide, so each combined frame puts it there,
    // beside the spinner, with the tool line in the ring behind it.
    const over = (file: string): AgentWorkFrame => ({
      screenTail: `${spinner.screenTail}\n${recorded(file).frame.screenTail}`,
      wideScreenTail: `${spinner.wideScreenTail}\n${recorded(file).frame.wideScreenTail}`,
      rawTail: `${tool}\n${recorded(file).frame.rawTail}`,
    })
    expect(AgentWorkInspectorClaude.inspect(over('claude-blocked-prompt.json')).hint).toBe('blocked')
    expect(AgentWorkInspectorClaude.inspect(over('claude-question-menu.json')).hint).toBe('waiting')
    // The tool line has to be ON the screen, beside the spinner: a tool line in the ring is a tool
    // that HAS run, which is exactly what this classifier stopped believing on 2026-08-20.
    expect(AgentWorkInspectorClaude.inspect({
      screenTail: `${recorded('claude-tool-use.json').frame.screenTail}\n${spinner.screenTail}`,
      wideScreenTail:
        `${recorded('claude-tool-use.json').frame.wideScreenTail}\n${spinner.wideScreenTail}`,
      rawTail: '',
    }).hint).toBe('tool-use')
  })

  // The false diamond of 2026-08-20, pinned. A session debugging the classifier quoted a captured
  // permission prompt into its own transcript - wording, selected row and all - and read as being AT
  // one. A quote scrolls up out of the shallow window; a real prompt is drawn in it.
  it('does not read a quoted prompt as a prompt', () => {
    const quoted = recorded('claude-live-permission-prompt.json').frame.screenTail
    const idle = recorded('claude-live-idle.json').frame
    const inspection = AgentWorkInspectorClaude.inspect({
      screenTail: idle.screenTail,
      wideScreenTail: `${quoted}\n${idle.screenTail}`,
      rawTail: `${quoted}\n${idle.rawTail}`,
    })

    expect(inspection.hint).toBe('idle')
    expect(inspection.evidence).toHaveLength(0)
  })
})
