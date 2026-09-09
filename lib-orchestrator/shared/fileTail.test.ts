import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { FileTail } from './fileTail'

describe('lib-orchestrator/shared/fileTail', () => {
  const created: string[] = []

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  function write(content: string): { file: string; size: number } {
    const directory = mkdtempSync(join(tmpdir(), 'jamat-v3-file-tail-'))
    created.push(directory)
    const file = join(directory, 'transcript.jsonl')
    writeFileSync(file, content, 'utf8')
    return { file, size: statSync(file).size }
  }

  it('returns the whole file when it fits under the ceiling', async () => {
    const { file, size } = write('first\nsecond\nthird\n')
    expect(await FileTail.read(file, size, 1024)).toBe('first\nsecond\nthird\n')
  })

  it('drops the truncated first line when the read starts past the beginning', async () => {
    const { file, size } = write('first\nsecond\nthird\n')
    // Twelve bytes back from the end lands inside `second`, so that line arrives cut in half.
    expect(await FileTail.read(file, size, 12)).toBe('third\n')
    expect(await FileTail.readBounded(file, size, 12)).toEqual({
      content: 'third\n',
      bytesRead: 12,
      startedAtFileBeginning: false,
    })
  })

  it('returns nothing when the window past the beginning holds no line break', async () => {
    const { file, size } = write(`head\n${'x'.repeat(20)}`)
    expect(await FileTail.read(file, size, 8)).toBe('')
  })

  // Every caller hands in a `size` from a stat taken EARLIER, while another program is writing the
  // file. Both directions are ordinary: the rotation that shrinks it and the append that grows it.
  it('reads only what is there when the size it was given is past the end of the file', async () => {
    const { file } = write('a\nb\n')
    // The whole file, and none of the bytes the buffer was sized for and never filled.
    expect(await FileTail.read(file, 400, 1_024)).toBe('a\nb\n')
    expect(await FileTail.readBounded(file, 400, 1_024)).toEqual({
      content: 'a\nb\n',
      bytesRead: 4,
      startedAtFileBeginning: true,
    })
    // And nothing at all when the stale size puts the window itself past the end.
    expect(await FileTail.read(file, 400, 8)).toBe('')
  })

  it('reads only as far as the size it was given, when the file has grown since', async () => {
    const { file } = write('first\nsecond\n')
    expect(await FileTail.read(file, 'first\n'.length, 1_024)).toBe('first\n')
  })

  it('returns nothing for an empty file', async () => {
    const { file, size } = write('')
    expect(await FileTail.read(file, size, 1024)).toBe('')
  })
})
