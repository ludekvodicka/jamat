import { describe, expect, it, vi } from 'vitest'

import {
  FileViewerLanguages,
} from '../../../lib-orchestrator/fileViewer/fileViewerLanguages'
import {
  FileViewerLimits,
} from '../../../lib-orchestrator/fileViewer/fileViewerLimits'
import { FileHighlighter } from './fileHighlighter'

const langMock = vi.hoisted(() => ({ attempts: 0 }))

/**
 * The first import of the TypeScript grammar fails, the second works.
 *
 * That is the whole case: a rejected promise used to stay in the cache, so ONE failed import - a dev
 * server reloading, a disk hiccup - left TypeScript unhighlighted until the window restarted, and
 * silently, because falling back to plain text is what an unknown language legitimately gets.
 */
vi.mock('shiki/langs/typescript.mjs', async (importOriginal) => {
  langMock.attempts += 1
  if (langMock.attempts === 1) throw new Error('the grammar could not be read')
  return await importOriginal<{ default: unknown }>()
})

describe('mdext-renderer/renderer/highlight/fileHighlighter', () => {
  /*
   * The library names a language per file type and this window keeps the grammars, and the two had
   * already drifted: `.gitignore` mapped to a `gitignore` nothing could load, so it opened
   * unhighlighted with nothing said. One test, over both lists.
   */
  it('has a grammar for every language the format registry can name', () => {
    const missing = FileViewerLanguages.all()
      .filter((language) => !FileHighlighter.supports(language))

    expect(missing).toEqual([])
  })

  it('folds the aliases a fence may be written with', () => {
    for (const alias of ['ts', 'js', 'py', 'yml', 'md', 'kt', 'sol', 'gql', 'c++', 'cs', 'rb'])
      expect(FileHighlighter.supports(alias), alias).toBe(true)
    // A language shiki does not have is not claimed.
    expect(FileHighlighter.supports('brainfuck')).toBe(false)
    // Plain text needs no grammar and is always drawable.
    expect(FileHighlighter.supports('plaintext')).toBe(true)
  })

  it('asks again for a language whose grammar failed to load once', async () => {
    const first = await FileHighlighter.html('const answer: number = 42', 'ts')
    expect(langMock.attempts).toBe(1)
    // Plain text, which is the honest answer while the grammar is not there.
    expect(first).not.toContain('shiki-themes')

    const second = await FileHighlighter.html('const answer: number = 42', 'ts')

    expect(langMock.attempts).toBe(2)
    expect(second).toContain('answer')
    // The grammar loaded this time, so the keyword is coloured rather than left plain.
    expect(second).not.toEqual(first)
  })

  /*
   * The guard that keeps one synchronous Shiki call off the drawing thread. Measured with the
   * shipped configuration: 1 MiB of plain TypeScript took 5.2 seconds, and one renderer draws every
   * panel of the window, so the terminal and the sessions tree stop for exactly that long. Emptying
   * the guard left every web suite green.
   *
   * The size is in BYTES, not characters, which is the half a length check would get wrong: 32 769
   * accented characters are 65 538 bytes.
   */
  it('refuses more source than the drawing thread can afford, measured in bytes', async () => {
    const overByBytesAlone = 'é'.repeat(FileViewerLimits.highlightBytes / 2 + 1)
    expect(overByBytesAlone.length).toBeLessThan(FileViewerLimits.highlightBytes)

    await expect(FileHighlighter.html(overByBytesAlone, 'ts')).rejects
      .toThrow(/limited to 65536 bytes/)
    await expect(FileHighlighter.lines(overByBytesAlone, 'ts')).rejects
      .toThrow(/limited to 65536 bytes/)

    // Exactly on the limit still draws, so the refusal is one byte past it and not one byte early.
    const onTheLimit = 'a'.repeat(FileViewerLimits.highlightBytes)
    expect((await FileHighlighter.lines(onTheLimit, 'text')).length).toBeGreaterThan(0)
  })

  it('loads a supported Shiki language on demand and falls back for unknown languages', async () => {
    const highlighted = await FileHighlighter.html('const answer: number = 42', 'ts')
    expect(highlighted).toContain('class="shiki')
    expect(highlighted).toContain('answer')
    const plain = await FileHighlighter.html('<plain>', 'unsupported-language')
    expect(plain).toContain('&#x3C;plain>')
  })
})
