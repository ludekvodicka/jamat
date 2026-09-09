import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { type RewriterIo, TranscriptRewriter } from './transcriptRewriter'

describe('lib-orchestrator/projectManager/providers/core/transcriptRewriter', () => {
  const created: string[] = []

  // Spelled out here rather than imported: the rewriter is provider-agnostic, and the real encoder
  // is wired in by the Claude migrator, whose own test is what proves that wiring.
  const encodeLikeClaude = (path: string): string => path.replace(/[^A-Za-z0-9]/g, '-')

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  function temporaryDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), 'jamat-v3-rewriter-'))
    created.push(directory)
    return directory
  }

  function diskIo(): RewriterIo {
    return {
      readFile: (file) => readFile(file, 'utf8'),
      writeFile: (file, content) => writeFile(file, content, 'utf8'),
      rename: (oldFile, newFile) => rename(oldFile, newFile),
      unlink: (file) => unlink(file),
    }
  }

  function failing(code: string): NodeJS.ErrnoException {
    const error: NodeJS.ErrnoException = new Error(`simulated ${code}`)
    error.code = code
    return error
  }

  interface RecordingIo {
    io: RewriterIo
    calls: string[]
  }

  function recording(content: string): RecordingIo {
    const calls: string[] = []
    return {
      calls,
      io: {
        readFile: async (file) => { calls.push(`read ${file}`); return content },
        writeFile: async (file) => { calls.push(`write ${file}`) },
        rename: async (oldFile, newFile) => { calls.push(`rename ${oldFile} -> ${newFile}`) },
        unlink: async (file) => { calls.push(`unlink ${file}`) },
      },
    }
  }

  const oldPath = 'Q:\\Apps\\Foo'
  const newPath = 'Q:\\Apps\\Bar'

  it('offers the three shapes a project path takes inside a transcript', () => {
    expect(TranscriptRewriter.replacementsOf(oldPath, newPath, encodeLikeClaude)).toEqual([
      ['Q:\\\\Apps\\\\Foo', 'Q:\\\\Apps\\\\Bar'],
      ['Q:/Apps/Foo', 'Q:/Apps/Bar'],
      ['Q--Apps-Foo', 'Q--Apps-Bar'],
    ])
  })

  it('rewrites all three shapes and leaves the encoded one alone when no encoder is given', async () => {
    const directory = temporaryDirectory()
    const line = '{"cwd":"Q:\\\\Apps\\\\Foo","other":"Q:/Apps/Foo","dir":"Q--Apps-Foo"}\n'

    const withEncoded = join(directory, 'with-encoded.jsonl')
    writeFileSync(withEncoded, line, 'utf8')
    await TranscriptRewriter.rewriteInPlace(
      withEncoded,
      TranscriptRewriter.replacementsOf(oldPath, newPath, encodeLikeClaude),
    )
    expect(readFileSync(withEncoded, 'utf8')).toBe(
      '{"cwd":"Q:\\\\Apps\\\\Bar","other":"Q:/Apps/Bar","dir":"Q--Apps-Bar"}\n',
    )

    const withoutEncoded = join(directory, 'without-encoded.jsonl')
    writeFileSync(withoutEncoded, line, 'utf8')
    await TranscriptRewriter.rewriteInPlace(
      withoutEncoded,
      TranscriptRewriter.replacementsOf(oldPath, newPath),
    )
    expect(readFileSync(withoutEncoded, 'utf8')).toBe(
      '{"cwd":"Q:\\\\Apps\\\\Bar","other":"Q:/Apps/Bar","dir":"Q--Apps-Foo"}\n',
    )
  })

  /**
   * A conversation names the directories beside the one it runs in, and every shape of `…/Foo` is a
   * prefix of `…/FooV3` - the encoded one included. Replacing there would leave a corrupted path in
   * the user's own transcript with nothing to report it; a shape this rule misses is at worst one
   * session that cannot be found, which is visible.
   */
  it('replaces a path only where the next character cannot continue a name', async () => {
    const directory = temporaryDirectory()
    const file = join(directory, 'siblings.jsonl')
    const line = '{"a":"Q:\\\\Apps\\\\Foo","b":"Q:\\\\Apps\\\\FooV3","c":"Q:/Apps/Foo",'
      + '"d":"Q:/Apps/FooV3","e":"Q--Apps-Foo","f":"Q--Apps-FooV3","g":"Q:\\\\Apps\\\\Foo\\\\Sub"}\n'
    writeFileSync(file, line, 'utf8')

    await TranscriptRewriter.rewriteInPlace(
      file,
      TranscriptRewriter.replacementsOf(oldPath, newPath, encodeLikeClaude),
    )

    expect(readFileSync(file, 'utf8')).toBe(
      '{"a":"Q:\\\\Apps\\\\Bar","b":"Q:\\\\Apps\\\\FooV3","c":"Q:/Apps/Bar",'
      + '"d":"Q:/Apps/FooV3","e":"Q--Apps-Bar","f":"Q--Apps-FooV3","g":"Q:\\\\Apps\\\\Bar\\\\Sub"}\n',
    )
  })

  // A file cut short mid-write ends where it ends; there is no character there to continue a name.
  it('replaces a path that the file ends on', async () => {
    const directory = temporaryDirectory()
    const file = join(directory, 'truncated.jsonl')
    writeFileSync(file, '{"cwd":"Q:/Apps/Foo', 'utf8')

    await TranscriptRewriter.rewriteInPlace(
      file,
      TranscriptRewriter.replacementsOf(oldPath, newPath, encodeLikeClaude),
    )

    expect(readFileSync(file, 'utf8')).toBe('{"cwd":"Q:/Apps/Bar')
  })

  it('writes nothing at all when no shape of the old path occurs', async () => {
    const { io, calls } = recording('{"cwd":"Q:\\\\Apps\\\\Other"}\n')
    const outcome = await TranscriptRewriter.rewriteInPlace(
      'transcript.jsonl',
      TranscriptRewriter.replacementsOf(oldPath, newPath, encodeLikeClaude),
      io,
    )
    expect(outcome).toBe('unchanged')
    expect(calls).toEqual(['read transcript.jsonl'])
  })

  // Finding 099: the content reaches the disk in a sibling file and only a rename touches the original.
  it('lands the new content through a sibling temp file and a rename', async () => {
    const { io, calls } = recording('{"cwd":"Q:/Apps/Foo"}\n')
    const outcome = await TranscriptRewriter.rewriteInPlace(
      'transcript.jsonl',
      TranscriptRewriter.replacementsOf(oldPath, newPath, encodeLikeClaude),
      io,
    )
    expect(outcome).toBe('rewritten')
    expect(calls).toEqual([
      'read transcript.jsonl',
      'write transcript.jsonl.tmp',
      'rename transcript.jsonl.tmp -> transcript.jsonl',
    ])
  })

  it('classifies a locked transcript, leaves it untouched and removes the temp file', async () => {
    const directory = temporaryDirectory()
    const file = join(directory, 'locked.jsonl')
    const original = '{"cwd":"Q:/Apps/Foo"}\n'
    writeFileSync(file, original, 'utf8')

    const outcome = await TranscriptRewriter.rewriteInPlace(
      file,
      TranscriptRewriter.replacementsOf(oldPath, newPath, encodeLikeClaude),
      { ...diskIo(), rename: async () => { throw failing('EBUSY') } },
    )

    expect(outcome).toBe('left-locked')
    expect(readFileSync(file, 'utf8')).toBe(original)
    expect(existsSync(`${file}.tmp`)).toBe(false)
  })

  it('throws a failure that is not a lock instead of reporting an outcome', async () => {
    const directory = temporaryDirectory()
    const file = join(directory, 'broken.jsonl')
    writeFileSync(file, '{"cwd":"Q:/Apps/Foo"}\n', 'utf8')

    await expect(TranscriptRewriter.rewriteInPlace(
      file,
      TranscriptRewriter.replacementsOf(oldPath, newPath, encodeLikeClaude),
      { ...diskIo(), rename: async () => { throw failing('EIO') } },
    )).rejects.toThrow(/EIO/)
    expect(existsSync(`${file}.tmp`)).toBe(false)
  })

  it('recognizes only the two codes a held-open file produces', () => {
    expect(TranscriptRewriter.isLockedError(failing('EBUSY'))).toBe(true)
    expect(TranscriptRewriter.isLockedError(failing('EPERM'))).toBe(true)
    expect(TranscriptRewriter.isLockedError(failing('ENOENT'))).toBe(false)
    expect(TranscriptRewriter.isLockedError('EBUSY')).toBe(false)
  })

  it('moves a transcript with its content rewritten', async () => {
    const directory = temporaryDirectory()
    const oldFile = join(directory, 'old.jsonl')
    const newFile = join(directory, 'new.jsonl')
    writeFileSync(oldFile, '{"cwd":"Q:\\\\Apps\\\\Foo"}\n', 'utf8')

    const outcome = await TranscriptRewriter.moveWithRewrite(
      oldFile,
      newFile,
      TranscriptRewriter.replacementsOf(oldPath, newPath, encodeLikeClaude),
    )

    expect(outcome).toBe('moved')
    expect(existsSync(oldFile)).toBe(false)
    expect(readFileSync(newFile, 'utf8')).toBe('{"cwd":"Q:\\\\Apps\\\\Bar"}\n')
  })

  it('keeps the rewritten copy when the original cannot be deleted', async () => {
    const directory = temporaryDirectory()
    const oldFile = join(directory, 'old.jsonl')
    const newFile = join(directory, 'new.jsonl')
    writeFileSync(oldFile, '{"cwd":"Q:/Apps/Foo"}\n', 'utf8')

    const outcome = await TranscriptRewriter.moveWithRewrite(
      oldFile,
      newFile,
      TranscriptRewriter.replacementsOf(oldPath, newPath, encodeLikeClaude),
      { ...diskIo(), unlink: async () => { throw failing('EPERM') } },
    )

    expect(outcome).toBe('copied-pending-delete')
    expect(readFileSync(newFile, 'utf8')).toBe('{"cwd":"Q:/Apps/Bar"}\n')
    expect(existsSync(oldFile)).toBe(true)
  })
})
