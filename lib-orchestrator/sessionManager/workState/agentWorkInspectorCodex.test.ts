import { describe, expect, it } from 'vitest'

import { AgentWorkInspectorCodex } from './agentWorkInspectorCodex'
import { ScreenTail } from './screenTail'
import type { WorkFixture } from './fixtures/workFixtures'
import { WorkFixtures } from './fixtures/workFixtures'

describe('lib-orchestrator/sessionManager/workState/agentWorkInspectorCodex', () => {
  const fixtures = WorkFixtures.of('codex')

  function recorded(file: string): WorkFixture {
    const fixture = fixtures.find((candidate) => candidate.file === file)
    if (fixture === undefined) throw new Error(`missing work fixture ${file}`)
    return fixture
  }

  it('has a recorded corpus to answer over', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(5)
  })

  // The corpus this tree inherited was V1 text about a screen, never a screen, which is how the
  // marker glyph moved without a single test noticing. This is the rule that stops that repeating:
  // the verdicts that matter are answered over frames recorded HERE, from a named build.
  it('holds frames recorded from this tree for the verdicts that matter', () => {
    for (const file of [
      'codex-live-working.json',
      'codex-live-working-bullet.json',
      'codex-live-working-background-terminal.json',
      'codex-live-working-wide-screen.json',
      'codex-live-background-terminal.json',
      'codex-live-background-terminal-narrow.json',
      'codex-live-approval.json',
      'codex-live-idle.json',
    ])
      expect(recorded(file).recorded, `${file} must carry recorded {build, capturedAt}`).toBeDefined()
  })

  it.each(fixtures.map((fixture) => [fixture.file, fixture] as const))(
    'classifies %s as its recorded screen says',
    (_file, fixture: WorkFixture) => {
      const inspection = AgentWorkInspectorCodex.inspect(fixture.frame)
      expect(inspection.hint).toBe(fixture.expected.hint)
    },
  )

  // Both observed spinner phases belong to one 0.148.0 animation, and a yielded terminal adds a
  // suffix rather than replacing the foreground row. All three remain foreground `working`.
  it('matches both working animation phases and the background-terminal suffix', () => {
    for (const file of [
      'codex-live-working.json',
      'codex-live-working-bullet.json',
      'codex-live-working-background-terminal.json',
    ]) {
      const live = recorded(file)
      expect(live.recorded?.build).toContain('codex')
      const inspection = AgentWorkInspectorCodex.inspect(live.frame)
      expect(inspection.hint, file).toBe('working')
      expect(inspection.evidence.map((item) => item.signal), file).toContain('workingRow')
      expect(inspection.evidence.map((item) => item.signal), file).not.toContain('backgroundTerminal')
      expect(inspection.evidence.map((item) => item.source), file).toEqual(['screen'])
    }
  })

  it('reads a live working row retained only in the wide screen window', () => {
    const live = recorded('codex-live-working-wide-screen.json')
    // This fixture preserves the windows produced before ScreenTail understood the final cursor-up
    // restoration. Re-windowing its wide source now reaches the active row instead of the unused
    // viewport rows kept in its recorded shallow window.
    const recordedColsConst = 120
    expect(ScreenTail.normalizeTty(ScreenTail.rows(
      live.frame.wideScreenTail,
      ScreenTail.screenRowsConst,
      recordedColsConst,
    ))).toContain('working')
    expect(ScreenTail.normalizeTty(live.frame.screenTail)).not.toContain('working')
    expect(ScreenTail.normalizeTty(live.frame.wideScreenTail)).toContain('working')

    const inspection = AgentWorkInspectorCodex.inspect(live.frame)
    expect(inspection.hint).toBe('working')
    expect(inspection.evidence).toEqual([expect.objectContaining({
      source: 'wide-screen',
      signal: 'workingRow',
    })])
  })

  it('does not read quoted working prose from the wide screen window', () => {
    const live = recorded('codex-live-working-wide-screen.json')
    const inspection = AgentWorkInspectorCodex.inspect({
      ...live.frame,
      wideScreenTail: '• Captured row: ◦ Working (47s • esc to interrupt)',
    })

    expect(inspection.hint).toBe('unknown')
    expect(inspection.evidence).toHaveLength(0)
  })

  // Once the foreground turn stops polling, Codex replaces Working with this row. It is the same
  // state the user reported: the prompt is free, but the terminal behind it is not finished.
  it('reads the current background-terminal wait as background work', () => {
    for (const file of [
      'codex-live-background-terminal.json',
      'codex-live-background-terminal-narrow.json',
    ]) {
      const inspection = AgentWorkInspectorCodex.inspect(recorded(file).frame)
      expect(inspection.hint, file).toBe('background')
      expect(inspection.evidence, file).toEqual([expect.objectContaining({
        source: 'screen',
        signal: 'backgroundTerminal',
      })])
    }
  })

  // The approval pass waited for a frame from 2026-08-19 to 2026-08-20 rather than guessing a
  // wording, and this is the frame it waited for. Producing it took `-a untrusted`: Codex approves
  // inside its own sandbox without asking, so an ordinary session never draws this screen.
  it('reads the approval prompt it finally has a frame for', () => {
    const inspection = AgentWorkInspectorCodex.inspect(recorded('codex-live-approval.json').frame)
    expect(inspection.hint).toBe('blocked')
    expect(inspection.evidence.map((item) => item.signal)).toContain('approvalPrompt')
  })

  it('lets an approval prompt outrank background work on the same screen', () => {
    const approval = recorded('codex-live-approval.json').frame
    const background = recorded('codex-live-background-terminal.json').frame
    const inspection = AgentWorkInspectorCodex.inspect({
      ...background,
      screenTail: `${background.screenTail}\n${approval.screenTail}`,
    })

    expect(inspection.hint).toBe('blocked')
    expect(inspection.evidence.map((item) => item.signal)).toContain('approvalPrompt')
  })

  /*
   * The prompt AFTER it has been answered, which is the state the ring and the wide window keep
   * holding long after the screen has moved on. Built by giving the approval frame's ring and wide
   * window an idle screen: that is exactly what a session looks like once a person has said yes and
   * the approved command printed little.
   *
   * It has to be built rather than recorded because the recorded approval frame cannot show it -
   * its own `rawTail` normalizes to eight characters, so the raw and wide reads were reach no
   * fixture ever exercised. Answering `blocked` here pins the row on "a person has to answer" with
   * nothing left to un-pin it: `settleDue` only re-inspects a session whose activity is `working`.
   */
  it('does not read an answered prompt out of the ring once the screen has moved on', () => {
    const approval = recorded('codex-live-approval.json').frame
    const idle = recorded('codex-live-idle.json').frame

    const inspection = AgentWorkInspectorCodex.inspect({
      ...approval,
      screenTail: idle.screenTail,
    })

    expect(inspection.hint).toBe('idle')
    expect(inspection.evidence.some((item) => item.signal === 'approvalPrompt')).toBe(false)
  })

  // The status is about what is alive NOW. Its old text in the wide window is history, just like a
  // finished spinner in the raw ring, and cannot hold the row green after the shallow screen moves.
  it('does not read background work outside the shallow screen', () => {
    const background = recorded('codex-live-background-terminal.json').frame
    const idle = recorded('codex-live-idle.json').frame
    const inspection = AgentWorkInspectorCodex.inspect({
      ...background,
      screenTail: idle.screenTail,
    })

    expect(inspection.hint).toBe('idle')
    expect(inspection.evidence.some((item) => item.signal === 'backgroundTerminal')).toBe(false)
  })

  // And it still does not fire on a screen that is merely talking. An empty prompt is not a prompt
  // waiting for a person.
  it('stays unknown where there is no approval to read', () => {
    for (const file of ['codex-unknown-prompt.json', 'codex-unknown-prose-collision.json']) {
      const inspection = AgentWorkInspectorCodex.inspect(recorded(file).frame)
      expect(inspection.hint, file).toBe('unknown')
      expect(inspection.evidence.some((item) => item.signal === 'approvalPrompt'), file).toBe(false)
    }
  })

  // Both halves of the 2026-08-20 change. A screen this build draws when it has finished says so,
  // and a screen with neither the working row nor the empty prompt is still an absence of evidence:
  // calling THAT idle would be reading a fact out of one.
  it('reads the empty prompt as finished, and an unrecognised screen as unknown', () => {
    const finished = AgentWorkInspectorCodex.inspect(recorded('codex-live-idle.json').frame)
    expect(finished.hint).toBe('idle')
    expect(finished.evidence.map((item) => item.signal)).toEqual(['emptyPrompt'])

    for (const file of ['codex-unknown-prompt.json', 'codex-unknown-prose-collision.json']) {
      const inspection = AgentWorkInspectorCodex.inspect(recorded(file).frame)
      expect(inspection.hint, file).toBe('unknown')
      expect(inspection.evidence, file).toHaveLength(0)
    }
  })

  // The placeholder is on screen while Codex works too, drawn under the row it is working on, so
  // the order of the two reads is what keeps a working session from reading as finished.
  it('lets the working row outrank the empty prompt it is drawn above', () => {
    const working = recorded('codex-live-working.json')
    expect(ScreenTail.normalizeTty(working.frame.screenTail)).toContain('askcodextodoanything')
    expect(AgentWorkInspectorCodex.inspect(working.frame).hint).toBe('working')
  })

  it('reads working above the unused rows of a tall serialized viewport', () => {
    const cols = 128
    const row = (text: string): string => text.padEnd(cols)
    const screen = [
      row('old transcript'),
      row('◦ Working (4m 30s • esc to interrupt)'),
      '',
      '',
      row('› Ask Codex to do anything'),
      '',
      row('  gpt-5.6-sol max · C:\\Projects\\NodeJs\\AppSecretKeeperV2 · Main [default]'),
      ...Array.from({ length: 20 }, () => ''),
    ].join('\r\n') + '\x1b[14A\x1b[2C\x1b[0m\x1b[?2004h\x1b[?1004h'
    const frame = ScreenTail.frameOf({ raw: '', screen, cols })

    expect(ScreenTail.normalizeTty(frame.screenTail)).toContain('working')
    expect(AgentWorkInspectorCodex.inspect(frame).hint).toBe('working')
  })

  // Xterm's serializer can encode a visual blank as cursor-forward. ANSI stripping removes that
  // command, so the fixed words must still identify the row after their whitespace disappears.
  it('matches a working row whose visual spaces are serialized as cursor movement', () => {
    const idle = recorded('codex-live-idle.json').frame
    const gap = '\x1b[1C'
    const screenTail = `\x1b[2m◦${gap}Working${gap}(4m${gap}51s${gap}•${gap}esc${gap}to${gap}interrupt)\x1b[0m\n\n› Ask Codex to do anything`
    const inspection = AgentWorkInspectorCodex.inspect({ ...idle, screenTail })

    expect(ScreenTail.stripAnsiLower(screenTail)).toContain('◦working(4m51s•esctointerrupt)')
    expect(inspection.hint).toBe('working')
    expect(inspection.evidence.map((item) => item.signal)).toContain('workingRow')

    const quoted = AgentWorkInspectorCodex.inspect({
      ...idle,
      screenTail: '• Captured row: ◦ Working (4m 51s • esc to interrupt)\n\n› Ask Codex to do anything',
    })
    expect(quoted.hint).toBe('idle')
  })

  it('keeps a full-width working row separate from the prompt below it', () => {
    const cols = 103
    const status = '• Working (9s • esc to interrupt) · 1 background terminal running · /ps to view · /stop to close'
    const screen = `${status.padEnd(cols)}› Ask Codex to do anything`
    const frame = ScreenTail.frameOf({ raw: '', screen, cols })

    expect(ScreenTail.stripAnsiLower(frame.screenTail))
      .toMatch(/\/stop to close[ \t]*\n› ask codex/)
    expect(AgentWorkInspectorCodex.inspect(frame).hint).toBe('working')
  })

  it('matches both background-terminal forms when cursor movement carries every visual gap', () => {
    const gap = '\x1b[1C'
    const cursorGaps = (text: string): string =>
      ScreenTail.stripAnsiLower(text).replaceAll(' ', gap)
    for (const [file, hint] of [
      ['codex-live-working-background-terminal.json', 'working'],
      ['codex-live-background-terminal.json', 'background'],
    ] as const) {
      const frame = recorded(file).frame
      const inspection = AgentWorkInspectorCodex.inspect({
        ...frame,
        screenTail: cursorGaps(frame.screenTail),
        wideScreenTail: cursorGaps(frame.wideScreenTail),
      })

      expect(inspection.hint, file).toBe(hint)
    }
  })

  // The wrapped row is what the second, ring-side read used to be for. It survives on the screen
  // alone because the pattern's whitespace classes span the breaks the terminal put in the row.
  it('matches the row the terminal broke across three lines', () => {
    const wrapped = recorded('codex-working-wrapped.json')
    expect(wrapped.frame.screenTail.split('\n').length).toBeGreaterThan(1)
    expect(AgentWorkInspectorCodex.inspect(wrapped.frame).evidence.map((item) => item.source))
      .toEqual(['screen'])
  })

  // The ring is never read for what a session is DOING, here as on the Claude side: a working row
  // that survives only in the ring is a turn that HAS worked, and the screen is what says whether
  // it still is. This pinned the opposite until 2026-08-20.
  it('ignores a working row that survives only in the raw tail', () => {
    const unknown = recorded('codex-unknown-prompt.json').frame
    const inspection = AgentWorkInspectorCodex.inspect({
      ...recorded('codex-working-row.json').frame,
      screenTail: unknown.screenTail,
      wideScreenTail: unknown.wideScreenTail,
    })
    expect(inspection.hint).toBe('unknown')
    expect(inspection.evidence.some((item) => item.source === 'raw')).toBe(false)
  })
})
