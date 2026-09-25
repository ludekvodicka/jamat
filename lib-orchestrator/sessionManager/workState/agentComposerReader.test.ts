import { describe, expect, it } from 'vitest'

import type { SessionAgentId } from '../sessionManagerApi.types'
import { AgentComposerReader } from './agentComposerReader'
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
  })
})
