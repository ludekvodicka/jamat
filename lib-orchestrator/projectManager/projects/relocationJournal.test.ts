import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { RelocationJournalDocument } from '../providers/providerContract.types'
import { RelocationJournal } from './relocationJournal'

describe('lib-orchestrator/projectManager/projects/relocationJournal', () => {
  const created: string[] = []

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  function temporaryDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), 'jamat-v3-journal-'))
    created.push(directory)
    return directory
  }

  function documentOf(operationId: string): RelocationJournalDocument {
    return {
      schemaVersion: 1,
      operationId,
      kind: 'rename',
      oldPath: 'Q:\\Apps\\Foo',
      newPath: 'Q:\\Apps\\Bar',
      directoryRenamed: false,
      steps: [],
    }
  }

  function reporter(): { report: (message: string) => void; messages: string[] } {
    const messages: string[] = []
    return { messages, report: (message) => messages.push(message) }
  }

  it('is on disk before anything else happens and reads back through pending', async () => {
    const directory = join(temporaryDirectory(), 'project-relocations')
    const { report, messages } = reporter()

    await RelocationJournal.open(directory, documentOf('op-1'))

    expect(existsSync(join(directory, 'op-1.json'))).toBe(true)
    expect(await RelocationJournal.pending(directory, report)).toEqual([documentOf('op-1')])
    expect(messages).toEqual([])
  })

  it('carries every checkpoint and the directory flag through the disk', async () => {
    const directory = temporaryDirectory()
    const { report } = reporter()
    const journal = await RelocationJournal.open(directory, documentOf('op-2'))

    journal.markDirectoryRenamed()
    journal.checkpoint({ provider: 'claude', file: 'a.jsonl', state: 'done' })
    journal.checkpoint({ provider: 'codex', file: 'b.jsonl', state: 'copied-pending-delete' })

    const [stored] = await RelocationJournal.pending(directory, report)
    expect(stored).toEqual({
      ...documentOf('op-2'),
      directoryRenamed: true,
      steps: [
        { provider: 'claude', file: 'a.jsonl', state: 'done' },
        { provider: 'codex', file: 'b.jsonl', state: 'copied-pending-delete' },
      ],
    })
    expect(journal.document()).toEqual(stored)
  })

  it('hands out a copy of the document, not the document itself', async () => {
    const journal = await RelocationJournal.open(temporaryDirectory(), documentOf('op-3'))
    journal.document().steps.push({ provider: 'claude', file: 'sneaked.jsonl', state: 'done' })
    expect(journal.document().steps).toEqual([])
  })

  // One broken relocation must not block the sweep that every later start depends on.
  it('reports a damaged journal, skips it and returns the readable ones', async () => {
    const directory = temporaryDirectory()
    const { report, messages } = reporter()
    await RelocationJournal.open(directory, documentOf('op-good'))
    writeFileSync(join(directory, 'op-broken.json'), '{ "schemaVersion": 1, "operationId"', 'utf8')
    writeFileSync(join(directory, 'op-wrong-kind.json'), JSON.stringify({
      ...documentOf('op-wrong-kind'),
      kind: 'teleport',
    }), 'utf8')

    const pending = await RelocationJournal.pending(directory, report)

    expect(pending).toEqual([documentOf('op-good')])
    expect(messages).toHaveLength(2)
    expect(messages.every((message) => message.includes('is unusable'))).toBe(true)
  })

  /**
   * The steps are a record, not an input: the resume runs the migration again and relies on its
   * idempotence. Failing the journal over one of them would hide an operation that really is
   * unfinished, and the file would be reported at every start from then on.
   */
  it('drops a damaged step and keeps the journal that carries it', async () => {
    const directory = temporaryDirectory()
    const { report, messages } = reporter()
    writeFileSync(join(directory, 'op-5.json'), JSON.stringify({
      ...documentOf('op-5'),
      directoryRenamed: true,
      steps: [
        { provider: 'claude', file: 'a.jsonl', state: 'done' },
        { provider: 'gemini', file: 'b.jsonl', state: 'done' },
        { provider: 'codex', file: '', state: 'done' },
        { provider: 'codex', file: 'c.jsonl', state: 'teleported' },
        'not a step',
      ],
    }), 'utf8')

    const pending = await RelocationJournal.pending(directory, report)

    expect(pending).toEqual([{
      ...documentOf('op-5'),
      directoryRenamed: true,
      steps: [{ provider: 'claude', file: 'a.jsonl', state: 'done' }],
    }])
    expect(messages).toEqual([])
  })

  it('treats a directory that was never written as no pending operations', async () => {
    const { report, messages } = reporter()
    const pending = await RelocationJournal.pending(
      join(temporaryDirectory(), 'never-written'),
      report,
    )
    expect(pending).toEqual([])
    expect(messages).toEqual([])
  })

  it('discards a finished journal and stays quiet about one already gone', async () => {
    const directory = temporaryDirectory()
    const { report } = reporter()
    await RelocationJournal.open(directory, documentOf('op-4'))

    await RelocationJournal.discard(directory, 'op-4')
    await RelocationJournal.discard(directory, 'op-4')

    expect(existsSync(join(directory, 'op-4.json'))).toBe(false)
    expect(await RelocationJournal.pending(directory, report)).toEqual([])
  })
})
