import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { ProviderTranscriptRef } from '../../projectManager/providerTranscriptView'
import type { SessionTranscriptMessage } from '../sessionTranscriptReaderApi.types'
import type { SessionTranscriptLimits } from '../sessionTranscriptSource'
import { ClaudeTranscriptTailFixtures } from './fixtures/claudeTranscriptTailFixtures'
import { SessionTranscriptSourceClaude } from './sessionTranscriptSourceClaude'

describe('lib-orchestrator/sessionTranscriptReader/claude/sessionTranscriptSourceClaude', () => {
  const created: string[] = []
  const limits: SessionTranscriptLimits = { maxMessages: 10, maxCharactersPerMessage: 2_000 }
  const at = ClaudeTranscriptTailFixtures.writtenAt()

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  function world(content: string): ProviderTranscriptRef {
    const directory = mkdtempSync(join(tmpdir(), 'jamat-claude-transcript-'))
    created.push(directory)
    const file = join(directory, 'transcript.jsonl')
    writeFileSync(file, content, 'utf8')
    const stats = statSync(file)
    return { agentId: 'claude', nativeSessionId: 'session', file, mtimeMs: stats.mtimeMs, size: stats.size }
  }

  function reading(
    ref: ProviderTranscriptRef,
    messages: SessionTranscriptMessage[],
    usedLimits: SessionTranscriptLimits = limits,
    earlierContentOmitted = false,
  ) {
    return {
      kind: 'messages',
      messages,
      bounds: {
        maxMessages: usedLimits.maxMessages,
        maxCharactersPerMessage: usedLimits.maxCharactersPerMessage,
        scannedBytes: ref.size,
      },
      earlierContentOmitted,
    }
  }

  // A session ends mid-write often enough that this is the ordinary shape of its last line.
  // Without the tolerance in `records` one half-written record answers `transcript unreadable`
  // for the whole conversation, which is the half this panel exists to show.
  it('retells what was written before a last line that was cut off', async () => {
    const ref = world(
      ClaudeTranscriptTailFixtures.userTurn('what broke the build')
      + '{"type":"user","message":{',
    )
    expect(await new SessionTranscriptSourceClaude().read(ref, limits)).toEqual(reading(ref, [
      { role: 'user', text: 'what broke the build', at, textTruncated: false },
    ]))
  })

  it('retells the conversation in the order it was written', async () => {
    const ref = world(
      ClaudeTranscriptTailFixtures.userTurn('what broke the build')
      + ClaudeTranscriptTailFixtures.assistantTurn('a missing import'),
    )
    expect(await new SessionTranscriptSourceClaude().read(ref, limits)).toEqual(reading(ref, [
      { role: 'user', text: 'what broke the build', at, textTruncated: false },
      { role: 'assistant', text: 'a missing import', at, textTruncated: false },
    ]))
  })

  it('leaves out everything that was not said in this conversation', async () => {
    const ref = world(
      ClaudeTranscriptTailFixtures.userTurn('<command-name>/clear</command-name>')
      + ClaudeTranscriptTailFixtures.userTurn('a sub-agent talking', { isSidechain: true })
      + ClaudeTranscriptTailFixtures.userTurn('the tool saying hello', { isMeta: true })
      + ClaudeTranscriptTailFixtures.userBlockTurn('the real question')
      + ClaudeTranscriptTailFixtures.assistantToolTurn()
      + ClaudeTranscriptTailFixtures.toolResultTurn()
      + ClaudeTranscriptTailFixtures.assistantTurn('the real answer'),
    )
    expect(await new SessionTranscriptSourceClaude().read(ref, limits)).toEqual(reading(ref, [
      { role: 'user', text: 'the real question', at, textTruncated: false },
      { role: 'assistant', text: 'the real answer', at, textTruncated: false },
    ]))
  })

  it('keeps the last messages the limits allow, each cut to the length they allow', async () => {
    const ref = world(
      ClaudeTranscriptTailFixtures.assistantTurn('one')
      + ClaudeTranscriptTailFixtures.assistantTurn('two')
      + ClaudeTranscriptTailFixtures.assistantTurn('three hundred'),
    )
    const shortLimits = { maxMessages: 2, maxCharactersPerMessage: 5 }
    expect(await new SessionTranscriptSourceClaude().read(ref, shortLimits))
      .toEqual(reading(ref, [
        { role: 'assistant', text: 'two', at, textTruncated: false },
        { role: 'assistant', text: 'three', at, textTruncated: true },
      ], shortLimits, true))
  })

  it('widens to the second pass when the first one holds fewer messages than asked for', async () => {
    const ref = world(
      ClaudeTranscriptTailFixtures.userTurn('the early question')
      + ClaudeTranscriptTailFixtures.padding(300 * 1_024)
      + ClaudeTranscriptTailFixtures.assistantTurn('the late answer'),
    )
    expect(ref.size).toBeGreaterThan(262_144)
    expect(await new SessionTranscriptSourceClaude().read(ref, limits)).toEqual(reading(ref, [
      { role: 'user', text: 'the early question', at, textTruncated: false },
      { role: 'assistant', text: 'the late answer', at, textTruncated: false },
    ]))
  })

  it('admits that earlier content was omitted when the bounded scan starts inside the file', async () => {
    const ref = world(
      ClaudeTranscriptTailFixtures.userTurn('outside the bounded scan')
      + ClaudeTranscriptTailFixtures.padding(1_100 * 1_024)
      + ClaudeTranscriptTailFixtures.assistantTurn('inside the bounded scan'),
    )
    const result = await new SessionTranscriptSourceClaude().read(ref, limits)

    expect(result).toMatchObject({
      kind: 'messages',
      messages: [{ role: 'assistant', text: 'inside the bounded scan' }],
      bounds: { scannedBytes: 1_048_576 },
      earlierContentOmitted: true,
    })
  })

  it('answers none for a transcript in which nothing was ever said', async () => {
    const ref = world(
      ClaudeTranscriptTailFixtures.assistantToolTurn() + ClaudeTranscriptTailFixtures.toolResultTurn(),
    )
    expect(await new SessionTranscriptSourceClaude().read(ref, limits))
      .toEqual({
        kind: 'none',
        code: 'no-messages-in-scanned-tail',
        reason: 'nothing was said in the scanned transcript tail',
      })
  })

  it('answers none instead of throwing when the transcript is not there to read', async () => {
    const ref = world(ClaudeTranscriptTailFixtures.userTurn('a question'))
    rmSync(ref.file)
    expect(await new SessionTranscriptSourceClaude().read(ref, limits)).toMatchObject({
      kind: 'none',
      code: 'transcript-unreadable',
    })
  })
})
