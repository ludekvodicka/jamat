import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { ProviderTranscriptRef } from '../../projectManager/providerTranscriptView'
import type { SessionTranscriptMessage } from '../sessionTranscriptReaderApi.types'
import type { SessionTranscriptLimits } from '../sessionTranscriptSource'
import { CodexRolloutTailFixtures } from './fixtures/codexRolloutTailFixtures'
import { SessionTranscriptSourceCodex } from './sessionTranscriptSourceCodex'

describe('lib-orchestrator/sessionTranscriptReader/codex/sessionTranscriptSourceCodex', () => {
  const created: string[] = []
  const limits: SessionTranscriptLimits = { maxMessages: 10, maxCharactersPerMessage: 2_000 }

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  function refOf(file: string): ProviderTranscriptRef {
    const stats = statSync(file)
    return { agentId: 'codex', nativeSessionId: 'session', file, mtimeMs: stats.mtimeMs, size: stats.size }
  }

  function rollout(content: string): ProviderTranscriptRef {
    const directory = mkdtempSync(join(tmpdir(), 'jamat-codex-transcript-'))
    created.push(directory)
    const file = join(directory, 'rollout.jsonl')
    writeFileSync(file, content, 'utf8')
    return refOf(file)
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

  it('retells the captured rollout once, though Codex wrote every turn of it twice', async () => {
    const file = join(import.meta.dirname, 'fixtures', CodexRolloutTailFixtures.sampleFileName())
    const ref = refOf(file)
    expect(await new SessionTranscriptSourceCodex().read(ref, limits))
      .toEqual(reading(ref, CodexRolloutTailFixtures.sampleTail().map((message) => ({
        role: message.role as SessionTranscriptMessage['role'],
        text: message.text,
        at: message.at,
        textTruncated: false,
      }))))
  })

  it('leaves out the context Codex injects as a user turn', async () => {
    const ref = rollout(
      CodexRolloutTailFixtures.userMessage('<environment_context>\n  <cwd>/work</cwd>\n</environment_context>')
      + CodexRolloutTailFixtures.userMessage('the real question')
      + CodexRolloutTailFixtures.agentMessageEvent('the real answer')
      + CodexRolloutTailFixtures.assistantMessage('the real answer'),
    )
    expect(await new SessionTranscriptSourceCodex().read(ref, limits)).toEqual(reading(ref, [
      { role: 'user', text: 'the real question', at: CodexRolloutTailFixtures.writtenAt(), textTruncated: false },
      { role: 'assistant', text: 'the real answer', at: CodexRolloutTailFixtures.writtenAt(), textTruncated: false },
    ]))
  })

  it('keeps the last messages the limits allow, each cut to the length they allow', async () => {
    const ref = rollout(
      CodexRolloutTailFixtures.assistantMessage('one')
      + CodexRolloutTailFixtures.assistantMessage('two')
      + CodexRolloutTailFixtures.assistantMessage('three hundred'),
    )
    const shortLimits = { maxMessages: 2, maxCharactersPerMessage: 5 }
    expect(await new SessionTranscriptSourceCodex().read(ref, shortLimits))
      .toEqual(reading(ref, [
        { role: 'assistant', text: 'two', at: CodexRolloutTailFixtures.writtenAt(), textTruncated: false },
        { role: 'assistant', text: 'three', at: CodexRolloutTailFixtures.writtenAt(), textTruncated: true },
      ], shortLimits, true))
  })

  it('widens to the second pass when the first one holds fewer messages than asked for', async () => {
    const ref = rollout(
      CodexRolloutTailFixtures.userMessage('the early question')
      + CodexRolloutTailFixtures.padding(600 * 1_024)
      + CodexRolloutTailFixtures.assistantMessage('the late answer'),
    )
    expect(ref.size).toBeGreaterThan(524_288)
    expect(await new SessionTranscriptSourceCodex().read(ref, limits)).toEqual(reading(ref, [
      { role: 'user', text: 'the early question', at: CodexRolloutTailFixtures.writtenAt(), textTruncated: false },
      { role: 'assistant', text: 'the late answer', at: CodexRolloutTailFixtures.writtenAt(), textTruncated: false },
    ]))
  })

  it('admits that earlier content was omitted when the bounded scan starts inside the file', async () => {
    const ref = rollout(
      CodexRolloutTailFixtures.userMessage('outside the bounded scan')
      + CodexRolloutTailFixtures.padding(4_200 * 1_024)
      + CodexRolloutTailFixtures.assistantMessage('inside the bounded scan'),
    )
    const result = await new SessionTranscriptSourceCodex().read(ref, limits)

    expect(result).toMatchObject({
      kind: 'messages',
      messages: [{ role: 'assistant', text: 'inside the bounded scan' }],
      bounds: { scannedBytes: 4 * 1_048_576 },
      earlierContentOmitted: true,
    })
  })

  it('answers none for a rollout in which nothing was ever said', async () => {
    const ref = rollout(
      CodexRolloutTailFixtures.agentMessageEvent('display only')
      + CodexRolloutTailFixtures.row('response_item', { type: 'reasoning', summary: [] }),
    )
    expect(await new SessionTranscriptSourceCodex().read(ref, limits))
      .toEqual({
        kind: 'none',
        code: 'no-messages-in-scanned-tail',
        reason: 'nothing was said in the scanned rollout tail',
      })
  })

  it('answers none instead of throwing when the rollout is not there to read', async () => {
    const ref = rollout(CodexRolloutTailFixtures.userMessage('a question'))
    rmSync(ref.file)
    expect(await new SessionTranscriptSourceCodex().read(ref, limits)).toMatchObject({
      kind: 'none',
      code: 'transcript-unreadable',
    })
  })
})
