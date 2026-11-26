import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { TranscriptTailReader, type TranscriptTailRef } from './transcriptTailReader'

class TestTailReader extends TranscriptTailReader<string, string, TranscriptTailRef> {
  reads = 0

  constructor() {
    super(async (id) => ({ file: `/transcripts/${id}.jsonl`, mtimeMs: 100, size: 50 }))
  }

  read(id: string): Promise<string> {
    return this.readTail(id)
  }

  protected missing(): string { return '' }
  protected async saltOf(): Promise<string> { return '' }
  protected async readFrom(ref: TranscriptTailRef): Promise<string> {
    this.reads += 1
    return `content:${ref.file}:${this.reads}`
  }
}

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

  it('retains up to 256 entries and promotes cache hits to the MRU end', async () => {
    const reader = new TestTailReader()
    for (let i = 0; i < 256; i += 1)
      await reader.read(`s-${i}`)
    expect(reader.reads).toBe(256)

    // Touch s-0 so it moves to the MRU end; s-1 is now the LRU entry.
    await reader.read('s-0')
    expect(reader.reads).toBe(256)

    // Inserting the 257th entry evicts s-1, NOT s-0.
    await reader.read('s-256')
    expect(reader.reads).toBe(257)

    // s-0 is still cached (no new read); s-1 was evicted (triggers a read).
    await reader.read('s-0')
    expect(reader.reads).toBe(257)
    await reader.read('s-1')
    expect(reader.reads).toBe(258)
  })
})
