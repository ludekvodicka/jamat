import { describe, expect, it } from 'vitest'

import type { ProviderTranscriptRef } from '../projectManager/providerTranscriptView'
import { SessionModelReader } from './sessionModelReader'
import type { SessionModelTranscriptResolver } from './sessionModelReader'
import type { SessionModelReading } from './sessionModelReaderApi.types'
import type { SessionModelContext, SessionModelSource } from './sessionModelSource'

describe('lib-orchestrator/sessionModelReader/sessionModelReader', () => {
  interface World {
    reader: SessionModelReader
    context: SessionModelContext
    /** How many times a source was handed the file. The source is the only thing that opens it. */
    opened(): number
    /** The mtime alone, for a rewrite that landed on the same number of bytes. */
    touch(): void
    /** The size alone, for a transcript appended to inside one mtime tick. */
    grow(size: number): void
    /** What the source reads from outside the transcript; the stat cannot see it move. */
    resalt(value: string): void
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
    let salt = ''
    let opened = 0
    const transcripts: SessionModelTranscriptResolver = {
      async resolve() { return ref },
    }
    const source: SessionModelSource = {
      agentId: 'claude',
      async cacheSaltOf(): Promise<string> { return salt },
      async read(handed): Promise<SessionModelReading> {
        opened += 1
        return { kind: 'ok', info: {
          model: 'claude-sonnet-4-5-20260101',
          modelLabel: 'Sonnet 4.5',
          effortLevel: null,
          contextTokens: handed.size,
          contextWindow: 200_000,
        } }
      },
    }
    return {
      reader: new SessionModelReader({ transcripts, sources: [source] }),
      context: contextOf('session'),
      opened: () => opened,
      touch: () => { ref = { ...ref!, mtimeMs: ref!.mtimeMs + 1 } },
      grow: (size) => { ref = { ...ref!, size } },
      resalt: (value) => { salt = value },
      lose: () => { ref = null },
    }
  }

  function contextOf(nativeSessionId: string): SessionModelContext {
    return { agentId: 'claude', cwd: 'Q:/Project', nativeSessionId, launchModel: null }
  }

  it('does not re-open an unmoved transcript on the next poll', async () => {
    const stage = world()
    const first = await stage.reader.read(stage.context)
    const second = await stage.reader.read(stage.context)
    expect(first.kind).toBe('ok')
    expect(second).toBe(first)
    expect(stage.opened()).toBe(1)
  })

  // Each half of the key on its own: a rewrite keeps the size and a same-tick append keeps the
  // mtime, and either one alone has to be enough or the reader draws a stale model for ever.
  it('reads again when only the mtime moved', async () => {
    const stage = world()
    await stage.reader.read(stage.context)
    stage.touch()
    await stage.reader.read(stage.context)
    expect(stage.opened()).toBe(2)
  })

  it('reads again when only the size moved', async () => {
    const stage = world()
    await stage.reader.read(stage.context)
    stage.grow(900)
    const fresh = await stage.reader.read(stage.context)
    expect(fresh).toMatchObject({ kind: 'ok', info: { contextTokens: 900 } })
    expect(stage.opened()).toBe(2)
  })

  // The effort is settings files, not the transcript. Without the salt an ended session keeps the
  // effort it had at its last turn until the window is restarted.
  it('reads again when what the source takes from outside the transcript moved', async () => {
    const stage = world()
    await stage.reader.read(stage.context)
    await stage.reader.read(stage.context)
    expect(stage.opened()).toBe(1)
    stage.resalt('low')
    await stage.reader.read(stage.context)
    expect(stage.opened()).toBe(2)
  })

  it('answers none without reading anything when no transcript resolves', async () => {
    const stage = world()
    stage.lose()
    expect(await stage.reader.read(stage.context))
      .toEqual({ kind: 'none', reason: 'no transcript for this session' })
    expect(stage.opened()).toBe(0)
  })

  it('remembers sixteen transcripts and forgets the oldest beyond that', async () => {
    let opened = 0
    const transcripts: SessionModelTranscriptResolver = {
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
    const source: SessionModelSource = {
      agentId: 'claude',
      async cacheSaltOf(): Promise<string> { return '' },
      async read(): Promise<SessionModelReading> {
        opened += 1
        return { kind: 'none', reason: 'nothing to say yet' }
      },
    }
    const reader = new SessionModelReader({ transcripts, sources: [source] })
    for (let index = 0; index < 17; index += 1) await reader.read(contextOf(`s${index}`))
    expect(opened).toBe(17)

    await reader.read(contextOf('s16'))
    expect(opened).toBe(17)

    await reader.read(contextOf('s0'))
    expect(opened).toBe(18)
  })

  /*
   * The touch, and what it is actually for. A HIT returns the entry where it stands - the order is
   * the order transcripts arrived, which the test above measures. The delete-then-set is about a
   * MISS on a file already in the cache: the transcript moved, so its reading is rebuilt, and the
   * rebuilt one must count as young. `Map.set` on a key that is already there leaves it where it
   * was, so without the delete the file somebody is actively writing to is the next one evicted.
   *
   * Deleting that one line left every other case in this file green.
   */
  it('makes a transcript that moved the youngest, not the one it already was', async () => {
    let opened = 0
    const mtimes = new Map<string, number>()
    const transcripts: SessionModelTranscriptResolver = {
      async resolve(input) {
        return {
          agentId: 'claude',
          nativeSessionId: input.nativeSessionId,
          file: `Q:/Project/${input.nativeSessionId}.jsonl`,
          mtimeMs: mtimes.get(input.nativeSessionId) ?? 1_000,
          size: 400,
        }
      },
    }
    const source: SessionModelSource = {
      agentId: 'claude',
      async cacheSaltOf(): Promise<string> { return '' },
      async read(): Promise<SessionModelReading> {
        opened += 1
        return { kind: 'none', reason: 'nothing to say yet' }
      },
    }
    const reader = new SessionModelReader({ transcripts, sources: [source] })
    const read = (name: string): Promise<SessionModelReading> => reader.read(contextOf(name))

    for (let index = 0; index < 16; index += 1) await read(`s${index}`)
    expect(opened).toBe(16)

    // `s0` is the oldest entry, and its file just moved: read again, and now it is the youngest.
    mtimes.set('s0', 2_000)
    await read('s0')
    expect(opened).toBe(17)

    // Seventeen entries for sixteen places, so one goes - and it is `s1`, the oldest that stood.
    await read('s16')
    expect(opened).toBe(18)

    await read('s0')
    expect(opened).toBe(18)
    await read('s1')
    expect(opened).toBe(19)
  })

  it('throws when an agent arrives that no source was wired for', async () => {
    const stage = world()
    await expect(stage.reader.read({ ...stage.context, agentId: 'codex' }))
      .rejects.toThrow('No session model source for agent: "codex"')
  })
})
