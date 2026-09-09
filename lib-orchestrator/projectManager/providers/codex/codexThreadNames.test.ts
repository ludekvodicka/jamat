import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { CodexThreadNames } from './codexThreadNames'

describe('lib-orchestrator/projectManager/providers/codex/codexThreadNames', () => {
  const created: string[] = []
  const renamedId = '019f4bf7-b5d8-74b0-9175-a5a5938a4082'
  const erasedId = '019f4c11-2a3b-7c4d-8e5f-6a7b8c9d0e1f'
  const unknownId = '019f4d22-3b4c-8d5e-9f60-1a2b3c4d5e6f'

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  interface Harness {
    indexFile: string
    names: CodexThreadNames
  }

  function harness(content?: string): Harness {
    const codexHome = mkdtempSync(join(tmpdir(), 'jamat-v3-codex-names-'))
    created.push(codexHome)
    const indexFile = join(codexHome, 'session_index.jsonl')
    if (content !== undefined) writeFileSync(indexFile, content, 'utf8')
    return { indexFile, names: new CodexThreadNames(codexHome) }
  }

  function fixture(): string {
    return readFileSync(join(import.meta.dirname, 'fixtures', 'session-index.jsonl'), 'utf8')
  }

  function setMtime(file: string, at: Date): void {
    utimesSync(file, at, at)
  }

  // A rename appends, so the same id appearing again is the normal case, not corruption.
  it('lets the last valid record for an id win, ignores broken ones and erases on an empty name', async () => {
    const { names } = harness(fixture())
    expect(await names.titleOf(renamedId)).toBe('Renamed later')
    expect(await names.titleOf(erasedId)).toBeNull()
    expect(await names.titleOf(unknownId)).toBeNull()
  })

  it('has no names when the file is not there', async () => {
    const { names } = harness()
    expect(await names.titleOf(renamedId)).toBeNull()
  })

  it('re-reads the file when its mtime moved, even at an unchanged size', async () => {
    const { indexFile, names } = harness(fixture())
    expect(await names.titleOf(renamedId)).toBe('Renamed later')

    const sameLength = fixture().replace('"Renamed later"', '"Renamed lat3r"')
    writeFileSync(indexFile, sameLength, 'utf8')
    const moved = new Date(Date.now() + 5_000)
    setMtime(indexFile, moved)

    expect(await names.titleOf(renamedId)).toBe('Renamed lat3r')
  })

  it('re-reads the file when its size moved, even at an unchanged mtime', async () => {
    const { indexFile, names } = harness(fixture())
    const frozen = new Date(Date.now() + 5_000)
    setMtime(indexFile, frozen)
    expect(await names.titleOf(renamedId)).toBe('Renamed later')

    const appended = `${fixture()}{"id":"${renamedId}","thread_name":"Renamed once more"}\n`
    writeFileSync(indexFile, appended, 'utf8')
    setMtime(indexFile, frozen)

    expect(await names.titleOf(renamedId)).toBe('Renamed once more')
  })

  it('serves an unchanged mtime and size from the cache', async () => {
    const { indexFile, names } = harness(fixture())
    const frozen = new Date(Date.now() + 5_000)
    setMtime(indexFile, frozen)
    expect(await names.titleOf(renamedId)).toBe('Renamed later')

    // Same length, same mtime: nothing tells the store the file moved, so the cached names stand.
    writeFileSync(indexFile, fixture().replace('"Renamed later"', '"Renamed lat3r"'), 'utf8')
    setMtime(indexFile, frozen)

    expect(await names.titleOf(renamedId)).toBe('Renamed later')
  })

  // The file belongs to Codex; a record of ours in it is a record nothing of ours would clean up.
  it('never writes to the index file', async () => {
    const { indexFile, names } = harness(fixture())
    const before = readFileSync(indexFile)

    await names.titleOf(renamedId)
    await names.titleOf(unknownId)

    expect(readFileSync(indexFile).equals(before)).toBe(true)
  })
})
