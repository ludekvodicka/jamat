import { appendFileSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TranscriptCursor, transcriptCursorSchema } from './transcriptCursor'

const io = vi.hoisted(() => ({ stats: 0, bytes: 0 }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromises>()
  return {
    ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => {
      io.stats += 1
      return actual.stat(...args)
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      const read = handle.read.bind(handle) as (...readArgs: unknown[]) => Promise<{ bytesRead: number }>
      ;(handle as unknown as { read: unknown }).read = async (...readArgs: unknown[]) => {
        const result = await read(...readArgs)
        io.bytes += result.bytesRead
        return result
      }
      return handle
    },
  }
})

describe('lib-orchestrator/sessionUncommitted/claims/transcriptCursor', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'jamat-cursor-'))
    io.stats = 0
    io.bytes = 0
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const prompt = (text: string, at = '2026-11-26T08:00:00.000Z') =>
    JSON.stringify({ type: 'user', uuid: `u-${text}`, timestamp: at, message: { content: text } })
  const edit = (id: string, path: string, at = '2026-11-26T08:00:01.000Z') => [
    JSON.stringify({ type: 'assistant', timestamp: at, message: { content: [
      { type: 'tool_use', id, name: 'Edit', input: { file_path: path, old_string: 'a', new_string: 'b' } }] } }),
    JSON.stringify({ type: 'user', timestamp: at, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } }),
  ].join('\n')
  const paths = (batch: Awaited<ReturnType<TranscriptCursor['read']>>) =>
    batch === 'unchanged' ? 'unchanged' : batch.mutations.map((mutation) => mutation.path)

  it('reads only the bytes a record added, and an unchanged file with one stat', async () => {
    const file = join(root, 't.jsonl')
    writeFileSync(file, `${prompt('go')}\n${edit('e1', 'Q:/P/a.ts')}\n`)
    const cursor = new TranscriptCursor('claude', 'session')
    expect(paths(await cursor.read(file))).toEqual(['Q:/P/a.ts'])
    const before = statSync(file).size
    const added = `${edit('e2', 'Q:/P/b.ts')}\n`
    appendFileSync(file, added)
    io.bytes = 0
    expect(paths(await cursor.read(file))).toEqual(['Q:/P/b.ts'])
    expect(io.bytes).toBe(statSync(file).size - before)
    expect(io.bytes).toBe(Buffer.byteLength(added))
    io.stats = 0
    io.bytes = 0
    expect(await cursor.read(file)).toBe('unchanged')
    expect(io).toEqual({ stats: 1, bytes: 0 })
  })

  it('decodes a record split across two chunks with a multi-byte character on the boundary once and intact', async () => {
    const file = join(root, 't.jsonl')
    const head = `${prompt('go')}\n`
    const opening = `{"type":"assistant","timestamp":"2026-11-26T08:00:01.000Z","message":{"content":[{"type":"tool_use","id":"e1","name":"Write","input":{"file_path":"Q:/P/a.ts","content":"`
    const fill = 'x'.repeat(TranscriptCursor.chunkBytesConst - Buffer.byteLength(head) - Buffer.byteLength(opening) - 1)
    const content = `${fill}€tail`
    const record = `${opening}${content}"}}]}}`
    writeFileSync(file, `${head}${record}\n${JSON.stringify({ type: 'user', timestamp: '2026-11-26T08:00:02.000Z',
      message: { content: [{ type: 'tool_result', tool_use_id: 'e1', content: 'ok' }] } })}\n`)
    // The euro sign's three bytes start one byte before the chunk ends.
    expect(Buffer.byteLength(`${head}${opening}${fill}`)).toBe(TranscriptCursor.chunkBytesConst - 1)
    const batch = await new TranscriptCursor('claude', 'session').read(file)
    expect(batch).not.toBe('unchanged')
    if (batch === 'unchanged') return
    expect(batch.mutations).toHaveLength(1)
    expect(batch.mutations[0]!.afterContent).toBe(content)
  })

  it('starts again on a shorter file or a new identity, and keeps reading forward otherwise', async () => {
    const file = join(root, 't.jsonl')
    writeFileSync(file, `${prompt('go')}\n${edit('e1', 'Q:/P/a.ts')}\n${edit('e2', 'Q:/P/b.ts')}\n`)
    const cursor = new TranscriptCursor('claude', 'session')
    expect(paths(await cursor.read(file))).toEqual(['Q:/P/a.ts', 'Q:/P/b.ts'])
    writeFileSync(file, `${prompt('again')}\n${edit('e3', 'Q:/P/c.ts')}\n`)
    expect(paths(await cursor.read(file))).toEqual(['Q:/P/c.ts'])

    const other = join(root, 'other.jsonl')
    writeFileSync(other, `${prompt('go')}\n${edit('e1', 'Q:/P/a.ts')}\n${edit('e4', 'Q:/P/d.ts')}\n${edit('e5', 'Q:/P/e.ts')}\n`)
    rmSync(file)
    const { renameSync } = await import('node:fs')
    renameSync(other, file)
    expect(paths(await cursor.read(file))).toEqual(['Q:/P/a.ts', 'Q:/P/d.ts', 'Q:/P/e.ts'])
  })

  it('starts again on an older time', async () => {
    const file = join(root, 't.jsonl')
    writeFileSync(file, `${prompt('go')}\n${edit('e1', 'Q:/P/a.ts')}\n`)
    const cursor = new TranscriptCursor('claude', 'session')
    await cursor.read(file)
    utimesSync(file, new Date('2020-01-01'), new Date('2020-01-01'))
    expect(paths(await cursor.read(file))).toEqual(['Q:/P/a.ts'])
  })

  it('continues from a saved state that went through JSON, and reads a broken extractor state from the start', async () => {
    const file = join(root, 't.jsonl')
    const pending = JSON.stringify({ type: 'assistant', timestamp: '2026-11-26T08:00:01.000Z', message: { content: [
      { type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: 'Q:/P/a.ts', old_string: 'a', new_string: 'b' } }] } })
    writeFileSync(file, `${prompt('go')}\n${pending}\n`)
    const first = new TranscriptCursor('claude', 'session')
    expect(paths(await first.read(file))).toEqual([])
    const saved = transcriptCursorSchema.parse(JSON.parse(JSON.stringify(first.state())))
    appendFileSync(file, `${JSON.stringify({ type: 'user', timestamp: '2026-11-26T08:00:02.000Z',
      message: { content: [{ type: 'tool_result', tool_use_id: 'e1', content: 'ok' }] } })}\n`)
    expect(paths(await new TranscriptCursor('claude', 'session', saved).read(file))).toEqual(['Q:/P/a.ts'])

    appendFileSync(file, `${edit('e2', 'Q:/P/b.ts')}\n`)
    const broken = { ...saved, extractor: { nonsense: true } }
    expect(paths(await new TranscriptCursor('claude', 'session', broken).read(file))).toEqual(['Q:/P/a.ts', 'Q:/P/b.ts'])
    expect(paths(await new TranscriptCursor('claude', 'subagent', saved).read(file))).toEqual(['Q:/P/a.ts', 'Q:/P/b.ts'])
  })
})
