import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CommitMessageFile } from './commitMessageFile'

describe('app-client-cli/app/commitMessageFile', () => {
  it('preserves multiline UTF-8 and sweeps only old owned message files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jamat-v3-message-test-'))
    try {
      const old = await CommitMessageFile.write('old', directory)
      await utimes(old, new Date(0), new Date(0))
      const unrelated = join(directory, 'keep.txt')
      await writeFile(unrelated, 'keep')
      await utimes(unrelated, new Date(0), new Date(0))
      const text = 'Příliš žluťoučký\n\nSecond line'
      const current = await CommitMessageFile.write(text, directory)
      expect(await readFile(current, 'utf8')).toBe(text)
      expect(CommitMessageFile.read(current)).toBe(text)
      expect(existsSync(current)).toBe(true)
      expect(existsSync(unrelated)).toBe(true)
      expect(existsSync(old)).toBe(false)
      expect(() => CommitMessageFile.validate('x'.repeat(16_385))).toThrow('16384')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
