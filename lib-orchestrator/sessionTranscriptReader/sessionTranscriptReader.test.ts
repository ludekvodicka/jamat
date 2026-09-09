import { describe, expect, it } from 'vitest'

import type { ProviderTranscriptRef } from '../projectManager/providerTranscriptView'
import { SessionTranscriptReader } from './sessionTranscriptReader'
import type {
  SessionTranscriptContext,
  SessionTranscriptResolver,
} from './sessionTranscriptReader'
import type { SessionTranscriptReading } from './sessionTranscriptReaderApi.types'
import type { SessionTranscriptLimits, SessionTranscriptSource } from './sessionTranscriptSource'

describe('lib-orchestrator/sessionTranscriptReader/sessionTranscriptReader', () => {
  interface World {
    reader: SessionTranscriptReader
    context: SessionTranscriptContext
    /** How many times a source was handed the file. The source is the only thing that opens it. */
    opened(): number
    handed: SessionTranscriptLimits[]
    move(size: number): void
    lose(): void
  }

  function world(): World {
    let ref: ProviderTranscriptRef | null = {
      agentId: 'claude',
      nativeSessionId: 'session',
      file: 'Q:/Project/transcript.jsonl',
      mtimeMs: 1_000,
      size: 400,
    }
    let opened = 0
    const handed: SessionTranscriptLimits[] = []
    const transcripts: SessionTranscriptResolver = {
      async resolve() { return ref },
    }
    const source: SessionTranscriptSource = {
      agentId: 'claude',
      async read(given, limits): Promise<SessionTranscriptReading> {
        opened += 1
        handed.push(limits)
        return {
          kind: 'messages',
          messages: [{
            role: 'assistant',
            text: `size ${given.size}`,
            at: null,
            textTruncated: false,
          }],
          bounds: {
            maxMessages: limits.maxMessages,
            maxCharactersPerMessage: limits.maxCharactersPerMessage,
            scannedBytes: given.size,
          },
          earlierContentOmitted: false,
        }
      },
    }
    return {
      reader: new SessionTranscriptReader({ transcripts, sources: [source] }),
      context: { agentId: 'claude', cwd: 'Q:/Project', nativeSessionId: 'session' },
      opened: () => opened,
      handed,
      move: (size) => { ref = { ...ref!, mtimeMs: ref!.mtimeMs + 1, size } },
      lose: () => { ref = null },
    }
  }

  it('does not re-open an unmoved transcript on the next look', async () => {
    const stage = world()
    const first = await stage.reader.read(stage.context)
    const second = await stage.reader.read(stage.context)
    expect(first.kind).toBe('messages')
    expect(second).toBe(first)
    expect(stage.opened()).toBe(1)
  })

  it('reads again once the transcript has moved', async () => {
    const stage = world()
    await stage.reader.read(stage.context)
    stage.move(900)
    const fresh = await stage.reader.read(stage.context)
    expect(fresh).toMatchObject({
      kind: 'messages',
      messages: [{ role: 'assistant', text: 'size 900', at: null, textTruncated: false }],
    })
    expect(stage.opened()).toBe(2)
  })

  it('retries a transient unreadable result without waiting for the file stat to change', async () => {
    let opened = 0
    const transcripts: SessionTranscriptResolver = {
      resolve: () => Promise.resolve({
        agentId: 'claude',
        nativeSessionId: 'session',
        file: 'Q:/Project/transcript.jsonl',
        mtimeMs: 1_000,
        size: 400,
      }),
    }
    const source: SessionTranscriptSource = {
      agentId: 'claude',
      read: () => {
        opened += 1
        return Promise.resolve(opened === 1
          ? {
              kind: 'none' as const,
              code: 'transcript-unreadable' as const,
              reason: 'temporarily locked',
            }
          : {
              kind: 'messages' as const,
              messages: [{
                role: 'assistant' as const,
                text: 'available now',
                at: null,
                textTruncated: false,
              }],
              bounds: { maxMessages: 10, maxCharactersPerMessage: 2_000, scannedBytes: 400 },
              earlierContentOmitted: false,
            })
      },
    }
    const reader = new SessionTranscriptReader({ transcripts, sources: [source] })
    const context = { agentId: 'claude' as const, cwd: 'Q:/Project', nativeSessionId: 'session' }

    await expect(reader.read(context)).resolves.toMatchObject({
      kind: 'none',
      code: 'transcript-unreadable',
    })
    await expect(reader.read(context)).resolves.toMatchObject({
      kind: 'messages',
      messages: [{ text: 'available now' }],
    })
    expect(opened).toBe(2)
  })

  it('answers none without reading anything when no transcript resolves', async () => {
    const stage = world()
    stage.lose()
    expect(await stage.reader.read(stage.context))
      .toEqual({
        kind: 'none',
        code: 'transcript-not-found',
        reason: 'no transcript for this session',
      })
    expect(stage.opened()).toBe(0)
  })

  it('hands the source the ten messages and two thousand characters it owns', async () => {
    const stage = world()
    await stage.reader.read(stage.context)
    expect(stage.handed).toEqual([{ maxMessages: 10, maxCharactersPerMessage: 2_000 }])
  })

  it('remembers sixteen transcripts and forgets the oldest beyond that', async () => {
    let opened = 0
    const transcripts: SessionTranscriptResolver = {
      async resolve(input) {
        return {
          agentId: 'claude',
          nativeSessionId: input.nativeSessionId,
          file: `Q:/Project/${input.nativeSessionId}.jsonl`,
          mtimeMs: 1_000,
          size: 400,
        }
      },
    }
    const source: SessionTranscriptSource = {
      agentId: 'claude',
      async read(): Promise<SessionTranscriptReading> {
        opened += 1
        return {
          kind: 'none',
          code: 'no-messages-in-scanned-tail',
          reason: 'nothing was said in the scanned transcript tail',
        }
      },
    }
    const reader = new SessionTranscriptReader({ transcripts, sources: [source] })
    for (let index = 0; index < 17; index += 1)
      await reader.read({ agentId: 'claude', cwd: 'Q:/Project', nativeSessionId: `s${index}` })
    expect(opened).toBe(17)

    await reader.read({ agentId: 'claude', cwd: 'Q:/Project', nativeSessionId: 's16' })
    expect(opened).toBe(17)

    await reader.read({ agentId: 'claude', cwd: 'Q:/Project', nativeSessionId: 's0' })
    expect(opened).toBe(18)
  })

  it('throws when an agent arrives that no source was wired for', async () => {
    const stage = world()
    await expect(stage.reader.read({ ...stage.context, agentId: 'codex' }))
      .rejects.toThrow('No session transcript source for agent: "codex"')
  })
})
