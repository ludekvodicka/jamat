import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { LeftoverEntry } from '../providers/providerContract.types'
import { RelocationLeftovers } from './relocationLeftovers'

describe('lib-orchestrator/projectManager/projects/relocationLeftovers', () => {
  const created: string[] = []

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  interface Harness {
    file: string
    messages: string[]
    leftovers: RelocationLeftovers
  }

  function harness(initial?: string): Harness {
    const directory = mkdtempSync(join(tmpdir(), 'jamat-v3-leftovers-'))
    created.push(directory)
    const file = join(directory, 'relocation-leftovers.json')
    if (initial !== undefined)
      writeFileSync(file, initial, 'utf8')
    const messages: string[] = []
    return { file, messages, leftovers: new RelocationLeftovers(file, (m) => messages.push(m)) }
  }

  function entryOf(path: string, kind: LeftoverEntry['kind'] = 'delete'): LeftoverEntry {
    if (kind === 'delete')
      return { kind, path, operationId: 'op-1', recordedAt: 1_700_000_000_000 }
    else if (kind === 'rewrite')
      return {
        kind,
        provider: 'claude',
        path,
        operationId: 'op-1',
        oldPath: 'Q:\\Apps\\Foo',
        newPath: 'Q:\\Apps\\Bar',
        recordedAt: 1_700_000_000_000,
      }
    else
      throw new Error(`Unknown leftover kind: ${JSON.stringify(kind)}`)
  }

  it('reads a file that was never written as an empty list', () => {
    const { leftovers, messages } = harness()
    expect(leftovers.entries()).toEqual([])
    expect(leftovers.count()).toBe(0)
    expect(messages).toEqual([])
  })

  it('records and removes through the disk, in the order they were recorded', () => {
    const { file, leftovers, messages } = harness()

    leftovers.record(entryOf('Q:/store/a.jsonl'))
    leftovers.record(entryOf('Q:/store/b.jsonl', 'rewrite'))

    const reopened = new RelocationLeftovers(file, (message) => messages.push(message))
    expect(reopened.entries()).toEqual([
      entryOf('Q:/store/a.jsonl'),
      entryOf('Q:/store/b.jsonl', 'rewrite'),
    ])

    reopened.remove(entryOf('Q:/store/a.jsonl'))
    expect(reopened.count()).toBe(1)
    expect(new RelocationLeftovers(file, (message) => messages.push(message)).entries())
      .toEqual([entryOf('Q:/store/b.jsonl', 'rewrite')])
    expect(messages).toEqual([])
  })

  it('keeps both records of the same file: replaying only the newer one would skip a rewrite', () => {
    const { leftovers } = harness()
    leftovers.record({ ...entryOf('Q:/store/a.jsonl', 'rewrite'), operationId: 'op-1' })
    leftovers.record({ ...entryOf('Q:/store/a.jsonl', 'rewrite'), operationId: 'op-2' })
    expect(leftovers.entries().map((entry) => entry.operationId)).toEqual(['op-1', 'op-2'])
  })

  it('drops a damaged record on read and keeps the rest', () => {
    const { leftovers, messages } = harness(JSON.stringify({
      schemaVersion: 1,
      entries: [entryOf('Q:/store/a.jsonl'), { kind: 'delete', path: '' }],
    }))

    expect(leftovers.entries()).toEqual([entryOf('Q:/store/a.jsonl')])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatch(/dropping a record/)
  })

  it('refuses to store a record it could not replay', () => {
    const { file, leftovers } = harness()
    expect(() => leftovers.record({ ...entryOf('Q:/store/a.jsonl'), recordedAt: Number.NaN }))
      .toThrow(/recordedAt/)
    expect(leftovers.count()).toBe(0)
    expect(existsSync(file)).toBe(false)
  })

  // Without it the sweep cannot know whether to replay the encoded shape of the path as well.
  it('refuses a rewrite record that does not name its provider, and drops one on read', () => {
    const { leftovers } = harness()
    const { provider, ...withoutProvider } = entryOf('Q:/store/a.jsonl', 'rewrite') as
      Extract<LeftoverEntry, { kind: 'rewrite' }>
    expect(provider).toBe('claude')
    expect(() => leftovers.record(withoutProvider as LeftoverEntry)).toThrow(/provider/)
    expect(() => leftovers.record({
      ...entryOf('Q:/store/a.jsonl', 'rewrite') as Extract<LeftoverEntry, { kind: 'rewrite' }>,
      provider: 'gemini' as 'codex',
    })).toThrow(/provider/)

    const stored = harness(JSON.stringify({
      schemaVersion: 1,
      entries: [withoutProvider, entryOf('Q:/store/b.jsonl', 'rewrite')],
    }))
    expect(stored.leftovers.entries()).toEqual([entryOf('Q:/store/b.jsonl', 'rewrite')])
    expect(stored.messages[0]).toMatch(/dropping a record .*provider/)
  })

  // A removal needs only the path, so demanding a provider there would store a fact that is not one:
  // the project directory belongs to neither provider's store.
  it('records a delete without a provider and keeps the rewrite ones apart', () => {
    const { file, leftovers, messages } = harness()
    leftovers.record(entryOf('Q:/project/dir'))
    leftovers.record({
      ...entryOf('Q:/codex/b.jsonl', 'rewrite') as Extract<LeftoverEntry, { kind: 'rewrite' }>,
      provider: 'codex',
    })
    const reopened = new RelocationLeftovers(file, (message) => messages.push(message))
    expect(reopened.entries().map((entry) => entry.kind === 'rewrite' ? entry.provider : null))
      .toEqual([null, 'codex'])
  })

  // The unreadable file still names files of the user's that are waiting to be cleaned up.
  it('latches on an unreadable file, reports once and never overwrites it', () => {
    const { file, leftovers, messages } = harness('{ "schemaVersion": 1, "entries"')
    const rawBefore = readFileSync(file, 'utf8')

    leftovers.record(entryOf('Q:/store/a.jsonl'))
    leftovers.record(entryOf('Q:/store/b.jsonl'))
    leftovers.remove(entryOf('Q:/store/a.jsonl'))

    expect(readFileSync(file, 'utf8')).toBe(rawBefore)
    expect(messages.filter((message) => message.includes('are unreadable'))).toHaveLength(1)
    expect(messages.filter((message) => message.includes('nothing is written'))).toHaveLength(1)
  })

  // The copy is on disk whether or not its record could be stored, and a caller that is told nothing
  // reports a clean operation over a file no sweep will ever come back to.
  it('says a latched record was refused and still keeps it for this process', () => {
    const { leftovers } = harness('{ "schemaVersion": 1, "entries"')

    const stored = leftovers.record(entryOf('Q:/store/a.jsonl'))

    expect(stored).toBe(false)
    expect(leftovers.entries()).toEqual([entryOf('Q:/store/a.jsonl')])
    expect(leftovers.count()).toBe(1)
    expect(leftovers.record(entryOf('Q:/store/b.jsonl', 'rewrite'))).toBe(false)
    expect(leftovers.entries()).toHaveLength(2)
  })

  it('confirms a record that reached the disk', () => {
    const { leftovers } = harness()
    expect(leftovers.record(entryOf('Q:/store/a.jsonl'))).toBe(true)
  })

  // Two records of one file are kept on purpose; removing by path alone threw away the other one.
  it('removes the record it was handed and leaves the other record of the same file', () => {
    const { file, leftovers, messages } = harness()
    const first = { ...entryOf('Q:/store/a.jsonl', 'rewrite'), operationId: 'op-1' }
    const second = { ...entryOf('Q:/store/a.jsonl', 'rewrite'), operationId: 'op-2' }
    leftovers.record(first)
    leftovers.record(second)

    leftovers.remove(first)

    expect(leftovers.entries()).toEqual([second])
    expect(new RelocationLeftovers(file, (message) => messages.push(message)).entries())
      .toEqual([second])
  })

  // Same file, same operation, two kinds: the delete of the old copy and the rewrite of the new one.
  it('tells the two kinds of record for one path apart', () => {
    const { leftovers } = harness()
    leftovers.record(entryOf('Q:/store/a.jsonl'))
    leftovers.record(entryOf('Q:/store/a.jsonl', 'rewrite'))

    leftovers.remove(entryOf('Q:/store/a.jsonl'))

    expect(leftovers.entries()).toEqual([entryOf('Q:/store/a.jsonl', 'rewrite')])
  })
})
