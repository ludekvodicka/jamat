import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { TranscriptTailReader } from './transcriptTailReader'

describe('lib-orchestrator/shared/transcriptTailReader', () => {
  const created: string[] = []

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  it('reports the actual bounded read and whether it started at byte zero', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'jamat-transcript-tail-'))
    created.push(directory)
    const file = join(directory, 'tail.jsonl')
    writeFileSync(file, 'first\nsecond\nthird\n', 'utf8')

    await expect(TranscriptTailReader.file({ file, size: 19 }, 12)).resolves.toEqual({
      content: 'third\n',
      scannedBytes: 12,
      startedAtFileBeginning: false,
    })
    await expect(TranscriptTailReader.file({ file, size: 400 }, 1_024)).resolves.toEqual({
      content: 'first\nsecond\nthird\n',
      scannedBytes: 19,
      startedAtFileBeginning: true,
    })
  })
})
