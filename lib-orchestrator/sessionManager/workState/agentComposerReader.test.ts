import { describe, expect, it } from 'vitest'

import type { SessionAgentId, TerminalComposerContent } from '../sessionManagerApi.types'
import { AgentComposerReader } from './agentComposerReader'
import type { ComposerViewport } from './agentWorkInspector.types'
import type { WorkFixture } from './fixtures/workFixtures'
import { WorkFixtures } from './fixtures/workFixtures'
import { ScreenTail } from './screenTail'

describe('lib-orchestrator/sessionManager/workState/agentComposerReader', () => {
  const fixtures = WorkFixtures.all()
  const readerFixtures = fixtures.filter((fixture) => fixture.expected.composer !== undefined)

  function recorded(file: string): WorkFixture {
    const fixture = fixtures.find((candidate) => candidate.file === file)
    if (fixture === undefined) throw new Error(`missing work fixture ${file}`)
    return fixture
  }

  function read(file: string): ReturnType<typeof AgentComposerReader.read> {
    const fixture = recorded(file)
    return AgentComposerReader.read(fixture.agent, fixture.frame)
  }

  it('has recorded composer frames for both agents, each from a named build', () => {
    for (const agent of ['claude', 'codex'] as const) {
      const own = readerFixtures.filter((fixture) => fixture.agent === agent)
      expect(own.length).toBeGreaterThanOrEqual(5)
      for (const fixture of own) expect(fixture.recorded, fixture.file).toBeDefined()
    }
  })

  it.each(readerFixtures.map((fixture) => [fixture.file, fixture] as const))(
    'reads %s as its recorded screen says',
    (_file, fixture: WorkFixture) => {
      expect(AgentComposerReader.read(fixture.agent, fixture.frame)).toEqual({
        composer: fixture.expected.composer,
        queuedRow: fixture.expected.queuedRow,
        echoHead: fixture.expected.echoHead,
        pastePlaceholders: fixture.expected.pastePlaceholders,
        onlyPlaceholders: (fixture.expected.pastePlaceholders ?? 0) > 0,
      })
    },
  )

  it('reads an empty box in the build that drew the marker and the rule on one serialized row', () => {
    expect(read('claude-live-idle.json').composer).toEqual({ state: 'empty' })
  })

  it('joins the continuation rows of a wrapped draft and keeps its words', () => {
    const composer = read('claude-live-composer-wrapped.json').composer
    if (composer.state !== 'text') throw new Error(`expected a draft, read ${composer.state}`)
    expect(composer.text.split('\n')).toHaveLength(3)
    expect(ScreenTail.normalizeTty(composer.text)).toBe(ScreenTail.normalizeTty(
      'Reply with the single word pong and nothing else. Then read '
      + 'E:/Temp/claude/fixture-notes/an-intentionally-long-pointer-path/that-keeps-going/until-it-wraps.md '
      + 'completely, follow every step it lists, and report back in one short paragraph when you are done with it.'))
    const codex = read('codex-live-composer-wrapped.json').composer
    if (codex.state !== 'text') throw new Error(`expected a draft, read ${codex.state}`)
    expect(ScreenTail.normalizeTty(codex.text)).toBe(ScreenTail.normalizeTty(composer.text))
  })

  it('keeps the case and the spaces of a typed draft', () => {
    for (const file of ['claude-live-composer-text.json', 'codex-live-composer-text.json'])
      expect(read(file).composer).toEqual({ state: 'text', text: 'Reply with the single word pong and nothing else.' })
  })

  it('counts a collapsed paste as a placeholder in both agents', () => {
    expect(read('claude-live-composer-pasted.json')).toMatchObject({
      composer: { state: 'text', text: '[Pasted text #1 +14 lines]' }, pastePlaceholders: 1,
    })
    expect(read('codex-live-composer-pasted.json')).toMatchObject({
      composer: { state: 'text', text: '[Pasted Content 1129 chars]' }, pastePlaceholders: 1,
    })
    expect(read('claude-live-composer-text.json').pastePlaceholders).toBe(0)
  })

  it('reads a draft as placeholders only when nothing else is typed around them', () => {
    const fixture = recorded('claude-live-composer-pasted.json')
    expect(AgentComposerReader.read('claude', fixture.frame).onlyPlaceholders).toBe(true)
    const surrounded = {
      ...fixture.frame,
      wideScreenTail: fixture.frame.wideScreenTail.replace('[Pasted', 'fix this [Pasted'),
    }
    expect(surrounded.wideScreenTail).not.toBe(fixture.frame.wideScreenTail)
    expect(AgentComposerReader.read('claude', surrounded)).toMatchObject({ pastePlaceholders: 1, onlyPlaceholders: false })
    expect(read('claude-live-composer-text.json').onlyPlaceholders).toBe(false)
  })

  it('finds no input box behind a dialog or before the agent has drawn one', () => {
    for (const file of [
      'claude-live-trust-dialog.json',
      'claude-live-booting.json',
      'claude-live-permission-prompt.json',
      'codex-live-booting.json',
      'codex-live-approval.json',
    ])
      expect(read(file).composer, file).toEqual({ state: 'absent' })
  })

  it('does not read an echoed or quoted menu row as a draft', () => {
    for (const file of ['claude-live-user-echo-collision.json', 'claude-live-quoted-menu-collision.json'])
      expect(read(file).composer.state, file).not.toBe('text')
  })

  // What makes a busy target ready: Codex draws its placeholder under a live status.
  it('reads the dimmed placeholder under a working status as an empty box', () => {
    expect(read('codex-live-working.json').composer).toEqual({ state: 'empty' })
    expect(read('codex-live-after-enter.json').composer).toEqual({ state: 'empty' })
    expect(read('claude-live-queued-while-working.json').composer).toEqual({ state: 'empty' })
  })

  it('reads a dimmed placeholder as empty whatever it says, and the same words undimmed as a draft', () => {
    const frame = recorded('claude-live-queued-while-working.json').frame
    const reworded = frame.wideScreenTail.replace('Press up to edit queued messages', 'Some other hint')
    expect(AgentComposerReader.read('claude', { ...frame, wideScreenTail: reworded }).composer)
      .toEqual({ state: 'empty' })
    const undimmed = frame.wideScreenTail.replace('\x1b[39;2mPress', '\x1b[39mPress')
    expect(AgentComposerReader.read('claude', { ...frame, wideScreenTail: undimmed }).composer)
      .toEqual({ state: 'text', text: 'Press up to edit queued messages' })
  })

  it.each([
    ['claude-live-queued-while-working.json', 'Press up to edit queued messages'],
    ['codex-live-idle.json', 'Ask Codex to do anything'],
  ])('reads the recorded placeholder through styled physical Host rows: %s', (file, placeholder) => {
    const fixture = recorded(file)
    const plain = fixture.frame.wideScreenTail.split('\n').map((row) => ScreenTail.stripAnsi(row
      .replace(/[^\x1b]\x1b\[1D\x1b\[1X/g, '')
      .replace(/\x1b\[(\d*)C/g, (_, count: string) => ' '.repeat(Number(count || '1')))).trimEnd())
    expect(plain.some((row) => row.includes(placeholder))).toBe(true)
    const screenLines = plain.map((row) => row.replace(placeholder, `\x1b[2m${placeholder}\x1b[22m`))
    const frame = ScreenTail.frameOf({ screen: '', cols: 120, screenLines, screenLinesStyled: true })
    expect(AgentComposerReader.read(fixture.agent, frame).composer).toEqual({ state: 'empty' })

    const changed = screenLines.map((row) => row.replace(placeholder, 'A different hint'))
    const changedFrame = ScreenTail.frameOf({
      screen: '', cols: 120, screenLines: changed, screenLinesStyled: true,
    })
    expect(AgentComposerReader.read(fixture.agent, changedFrame).composer).toEqual({ state: 'empty' })
    const undimmed = ScreenTail.frameOf({
      screen: '', cols: 120, screenLines: changed.map((row) => ScreenTail.stripAnsi(row)), screenLinesStyled: true,
    })
    expect(AgentComposerReader.read(fixture.agent, undimmed).composer)
      .toEqual({ state: 'text', text: 'A different hint' })
    const legacy = ScreenTail.frameOf({
      screen: fixture.frame.wideScreenTail, cols: 120, screenLines: plain,
    })
    expect(AgentComposerReader.read(fixture.agent, legacy).composer).toEqual({ state: 'absent' })
  })

  it('reads the unstyled boot suggestion as an empty box, and any other plain draft as text', () => {
    expect(read('claude-live-composer-suggestion.json').composer).toEqual({ state: 'empty' })
    const frame = recorded('claude-live-composer-suggestion.json').frame
    expect(AgentComposerReader.read('claude', {
      ...frame, wideScreenTail: frame.wideScreenTail.replace('refactor\x1b[1C<filepath>', 'fix\x1b[1Clint\x1b[1Cerrors'),
    }).composer).toEqual({ state: 'empty' })
    for (const [from, to] of [
      ['Try\x1b[1C"refactor\x1b[1C<filepath>"', 'refactor\x1b[1Cthe\x1b[1Cparser'],
      ['"refactor\x1b[1C<filepath>"', '"refactor\x1b[1C<filepath>"\x1b[1Cplease'],
      ['Try\x1b[1C"', 'Tried\x1b[1C"'],
    ]) {
      const wideScreenTail = frame.wideScreenTail.replace(from, to)
      expect(wideScreenTail).not.toBe(frame.wideScreenTail)
      expect(AgentComposerReader.read('claude', { ...frame, wideScreenTail }).composer.state, to).toBe('text')
    }
  })

  it('sees the queued row and the newest echo only where the recorded screen shows them', () => {
    expect(read('claude-live-queued-while-working.json')).toMatchObject({
      queuedRow: true, echoHead: 'afterwardsalsoreplywiththewordqueued-probe.',
    })
    expect(read('claude-live-after-enter.json')).toMatchObject({
      queuedRow: false, echoHead: 'writea600-wordstoryaboutalighthousekeeper.',
    })
    expect(read('codex-live-queued-while-working.json')).toMatchObject({ queuedRow: true, echoHead: null })
    const queued = ['claude-live-queued-while-working.json', 'codex-live-queued-while-working.json']
    for (const fixture of readerFixtures.filter((candidate) => !queued.includes(candidate.file)))
      expect(AgentComposerReader.read(fixture.agent, fixture.frame).queuedRow, fixture.file).toBe(false)
    for (const fixture of readerFixtures.filter((candidate) => candidate.agent === 'codex'))
      expect(AgentComposerReader.read(fixture.agent, fixture.frame).echoHead, fixture.file).toBeNull()
  })

  it('throws for an agent it does not know', () => {
    expect(() => AgentComposerReader.read('gemini' as SessionAgentId, recorded('claude-live-idle.json').frame))
      .toThrow('Unknown agent')
    expect(() => AgentComposerReader.content('gemini' as SessionAgentId, { rows: [], cols: 120, height: 30 }))
      .toThrow('Unknown agent')
  })

  describe('content', () => {
    const contentFixtures = fixtures.filter((fixture) => fixture.expected.content !== undefined)
    const rule = '─'.repeat(120)
    const codexFooter = '  gpt-6-astra xhigh · Q:\\PROJECT'

    function content(file: string): TerminalComposerContent {
      const fixture = recorded(file)
      return AgentComposerReader.content(fixture.agent, WorkFixtures.viewportOf(fixture))
    }

    function textOf(file: string): { text: string; eraseBound: number } {
      const read = content(file)
      if (read.kind !== 'text') throw new Error(`expected the whole draft of ${file}, read ${read.kind}`)
      return read
    }

    function viewport(rows: string[], height = 30): ComposerViewport {
      return { rows, cols: 120, height }
    }

    it('has viewport readings for both agents, each recorded at a stated width', () => {
      for (const agent of ['claude', 'codex'] as const)
        expect(contentFixtures.filter((fixture) => fixture.agent === agent).length).toBeGreaterThanOrEqual(10)
      for (const fixture of contentFixtures) {
        expect(fixture.recorded?.cols, fixture.file).toBeDefined()
        expect(fixture.provenance.capture, fixture.file).not.toBe('')
      }
    })

    it.each(contentFixtures.map((fixture) => [fixture.file, fixture] as const))(
      'reads the whole draft of %s as its recorded screen says',
      (_file, fixture: WorkFixture) => {
        expect(AgentComposerReader.content(fixture.agent, WorkFixtures.viewportOf(fixture)))
          .toEqual(fixture.expected.content)
      },
    )

    // The sent line is the reference, so the row join is proven against what was typed, not itself.
    it('joins a wrapped draft back into the one line that was sent, while read keeps its rows', () => {
      const sent = 'Reply with the single word pong and nothing else. Then read '
        + 'E:/Temp/claude/fixture-notes/an-intentionally-long-pointer-path/that-keeps-going/until-it-wraps.md '
        + 'completely, follow every step it lists, and report back in one short paragraph when you are done with it.'
      for (const file of ['claude-live-composer-wrapped.json', 'codex-live-composer-wrapped.json']) {
        expect(textOf(file).text, file).toBe(sent)
        const composer = read(file).composer
        if (composer.state !== 'text') throw new Error(`expected a draft, read ${composer.state}`)
        expect(composer.text.split('\n'), file).toHaveLength(3)
      }
    })

    it('joins a token longer than a row and a hyphenated name back into the typed line at both widths', () => {
      const typed = 'Reply with pong. Then read E:/Temp/claude/fixture-notes/'
        + 'aVeryLongDirectoryNameWithoutAnyBreakOpportunityThatIsLongerThanOneWholeRowOfTheTerminalAtOneHundredTwentyColumnsWideForSure/'
        + 'notes.md and the-hyphenated-file-name-that-keeps-going-on-and-on-past-the-end-of-the-row-for-the-join-rule.md now.'
      for (const file of [
        'claude-live-composer-long-token-120.json',
        'claude-live-composer-long-token-80.json',
        'codex-live-composer-long-token-120.json',
        'codex-live-composer-long-token-80.json',
      ]) {
        const draft = textOf(file)
        expect(draft.text, file).toBe(typed)
        expect(draft.eraseBound, file).toBeGreaterThanOrEqual(typed.length)
      }
    })

    it('reads a one-row draft exactly as read does, with room to erase all of it', () => {
      for (const file of ['claude-live-composer-text.json', 'codex-live-composer-text.json']) {
        const draft = textOf(file)
        expect(read(file).composer, file).toEqual({ state: 'text', text: draft.text })
        expect(draft.eraseBound, file).toBeGreaterThanOrEqual('Reply with the single word pong and nothing else.'.length)
      }
    })

    it('keeps a blank row inside the draft, and read now sees the whole box too', () => {
      for (const file of ['claude-live-composer-blank-line.json', 'codex-live-composer-blank-line.json']) {
        expect(textOf(file).text, file).toBe('Reply with the word pong.\n\nThen stop.')
        expect(read(file).composer, file).toEqual({ state: 'text', text: 'Reply with the word pong.\n\nThen stop.' })
      }
    })

    it('refuses a collapsed paste and an attached image in both agents', () => {
      for (const file of [
        'claude-live-composer-pasted.json',
        'codex-live-composer-pasted.json',
        'claude-live-composer-image.json',
        'codex-live-composer-image.json',
      ])
        expect(content(file), file).toEqual({ kind: 'placeholder' })
    })

    it('reads the placeholder, the queued hint and the boot suggestion as empty, and a dialog as absent', () => {
      for (const file of [
        'claude-live-queued-while-working.json',
        'claude-live-composer-suggestion.json',
        'codex-live-idle.json',
        'codex-live-composer-empty.json',
      ])
        expect(content(file), file).toEqual({ kind: 'empty' })
      for (const file of ['claude-live-trust-dialog.json', 'codex-live-booting.json'])
        expect(content(file), file).toEqual({ kind: 'absent' })
    })

    it('never takes a draft taller than its box shows', () => {
      for (const file of ['claude-live-composer-tall.json', 'codex-live-composer-tall.json'])
        expect(content(file), file).toEqual({ kind: 'clipped' })
    })

    it('reads wide and combining characters as drawn, with room to erase the typed text', () => {
      const typed = 'Reply with pong \u{1F44D} then read \u65E5\u672C\u8A9E\u306E\u30C6\u30AD\u30B9\u30C8 and cafe\u0301 now.'
      // Claude draws the accent composed into one character, Codex draws it nowhere: neither screen
      // holds the typed sequence, so each reading returns what its agent drew.
      const claude = textOf('claude-live-composer-unicode.json')
      expect(claude.text).toBe(typed.normalize('NFC'))
      expect(claude.eraseBound).toBeGreaterThanOrEqual(typed.length)
      const codex = textOf('codex-live-composer-unicode.json')
      expect(codex.text).toBe(typed.replace('\u0301', ''))
      expect(codex.eraseBound).toBeGreaterThanOrEqual(typed.length)
    })

    it('bounds the erase by the draft rows, one boundary character per row and the reserve', () => {
      expect(AgentComposerReader.content('claude', viewport(['', rule, '> ab cd', '  ef', rule, '  footer'])))
        .toEqual({ kind: 'text', text: 'ab cd\nef', eraseBound: 5 + 2 + 2 + 8 })
    })

    it('reads a box on the top edge as clipped, and the same box one row lower as the draft', () => {
      const claudeBox = [rule, '> fix the parser', rule, '  footer']
      expect(AgentComposerReader.content('claude', viewport(claudeBox))).toEqual({ kind: 'clipped' })
      expect(AgentComposerReader.content('claude', viewport(['', ...claudeBox])))
        .toMatchObject({ kind: 'text', text: 'fix the parser' })
      // Codex's own blank row over the marker is the box's top: `codex-live-composer-tall.json`.
      const codexBox = ['', '› fix the parser', '', codexFooter]
      expect(AgentComposerReader.content('codex', viewport(codexBox))).toEqual({ kind: 'clipped' })
      expect(AgentComposerReader.content('codex', viewport(['', ...codexBox])))
        .toMatchObject({ kind: 'text', text: 'fix the parser' })
      expect(AgentComposerReader.content('codex', viewport(['› fix the parser', '', codexFooter])))
        .toEqual({ kind: 'clipped' })
    })

    it('refuses a Claude box as tall as Claude lets it grow at that height', () => {
      const box = (rows: number): string[] => ['', rule, '> row 1',
        ...Array.from({ length: rows - 1 }, (_, index) => `  row ${index + 2}`), rule, '  footer']
      expect(AgentComposerReader.content('claude', viewport(box(9), 30))).toMatchObject({ kind: 'text' })
      expect(AgentComposerReader.content('claude', viewport(box(10), 30))).toEqual({ kind: 'clipped' })
      expect(AgentComposerReader.content('claude', viewport(box(4), 20))).toMatchObject({ kind: 'text' })
      expect(AgentComposerReader.content('claude', viewport(box(5), 20))).toEqual({ kind: 'clipped' })
      expect(AgentComposerReader.content('claude', viewport(box(2), 12))).toMatchObject({ kind: 'text' })
      expect(AgentComposerReader.content('claude', viewport(box(3), 12))).toEqual({ kind: 'clipped' })
    })

    it('never takes text from a box whose end it cannot prove', () => {
      const cases: [SessionAgentId, string[]][] = [
        ['claude', ['', rule, '> fix the parser', '  and the tests']],
        ['claude', ['', rule, '> fix the parser', '  and the tests', 'output that is not a rule', rule]],
        // An echo of a sent message with no box under it.
        ['codex', ['', '› fix the parser', '', '• Working (3s • esc to interrupt)']],
        ['codex', ['', '› fix the parser', '  and the tests']],
        // A popup under the box instead of the footer.
        ['codex', ['', '› /mo', '', '  /model   choose what model to use', '  /mode    switch the mode']],
        // Rows after the box that are not the footer.
        ['codex', ['', '› fix the parser', '', 'not the footer', codexFooter]],
        ['codex', ['', '› fix the parser', '', codexFooter, 'below the footer']],
      ]
      for (const [agent, rows] of cases)
        expect(AgentComposerReader.content(agent, viewport(rows)).kind, rows.join(' | ')).toBe('absent')
    })

    it('reads a Codex box over a footer of two rows, but not over three', () => {
      const box = ['history', '', '› fix the parser', '', codexFooter]
      expect(AgentComposerReader.content('codex', viewport([...box, '  ? for shortcuts'])))
        .toMatchObject({ kind: 'text', text: 'fix the parser' })
      expect(AgentComposerReader.content('codex', viewport([...box, '  ? for shortcuts', '  more']))).toEqual({ kind: 'absent' })
    })
  })
})
