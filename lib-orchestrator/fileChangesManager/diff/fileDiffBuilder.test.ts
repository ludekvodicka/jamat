import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { FileDiffBuilder } from './fileDiffBuilder'
import { FileDiffComputer } from './fileDiffComputer'

describe('lib-orchestrator/fileChangesManager/diff/fileDiffBuilder', () => {
  it('returns renderer-safe hunks with line numbers and EOL metadata', async () => {
    const result = await new FileDiffBuilder(new FileDiffComputer()).build({
      status: 'modified',
      completeness: 'full',
      detail: null,
      baseline: { label: 'HEAD', path: 'file.ts', content: 'one\r\ntwo\r\n' },
      current: { label: 'Working tree', path: 'file.ts', content: Buffer.from('one\nthree\n') },
    })
    expect(result).toEqual({
      ok: true,
      kind: 'text',
      data: expect.objectContaining({
        baseline: expect.objectContaining({ eol: 'crlf', finalNewline: true }),
        current: expect.objectContaining({ eol: 'lf', finalNewline: true }),
        hunks: [expect.objectContaining({
          lines: [
            { kind: 'context', text: 'one', beforeLine: 1, afterLine: 1 },
            { kind: 'remove', text: 'two', beforeLine: 2, afterLine: null },
            { kind: 'add', text: 'three', beforeLine: null, afterLine: 2 },
          ],
        })],
      }),
    })
  })

  it('returns binary, too-large and missing outcomes without constructing a diff', async () => {
    const builder = new FileDiffBuilder({
      async execute() { throw new Error('A text gate called the executor') },
    })
    expect(await builder.build({
      status: 'modified',
      completeness: 'full',
      detail: null,
      baseline: { label: 'HEAD', path: 'x', content: 'text' },
      current: { label: 'Current', path: 'x', content: Buffer.from([1, 0, 2]) },
    })).toEqual(expect.objectContaining({ kind: 'binary' }))
    expect(await builder.build({
      status: 'modified',
      completeness: 'full',
      detail: null,
      baseline: { label: 'HEAD', path: 'x', content: 'text' },
      current: { label: 'Current', path: 'x', content: 'x'.repeat(2 * 1_048_576 + 1) },
    })).toEqual(expect.objectContaining({ kind: 'too-large' }))
    expect(await builder.build({
      status: 'deleted',
      completeness: 'full',
      detail: null,
      baseline: { label: 'HEAD', path: 'x', content: null },
      current: { label: 'Current', path: 'x', content: null },
    })).toEqual(expect.objectContaining({ kind: 'missing' }))
  })

  it('compares a binary file by size and SHA-256 of both sides and says whether the working file equals the baseline', async () => {
    const builder = new FileDiffBuilder({
      async execute() { throw new Error('A binary file called the executor') },
    })
    const mine = Buffer.from([0x89, 0x50, 0x00, 0x01])
    const incoming = Buffer.from([0x89, 0x50, 0x00, 0x02, 0x03])
    const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
    const of = (baseline: Buffer | string | null, current: Buffer | null) => builder.build({
      status: 'modified', completeness: 'full', detail: null,
      baseline: { label: 'BASE', path: 'pic.bin', content: baseline },
      current: { label: 'Working tree', path: 'pic.bin', content: current },
    })

    expect(await of(incoming, mine)).toEqual({ ok: true, kind: 'binary', detail: 'Binary file, no text diff. '
      + `Working tree: 4 bytes, SHA-256 ${sha(mine)}. BASE: 5 bytes, SHA-256 ${sha(incoming)}. The working tree file differs from BASE.` })
    expect(await of(Buffer.from(mine), mine)).toEqual(expect.objectContaining({ detail: 'Binary file, no text diff. '
      + `Working tree: 4 bytes, SHA-256 ${sha(mine)}. BASE: 4 bytes, SHA-256 ${sha(mine)}. The working tree file equals BASE.` }))
    expect(await of(null, mine)).toEqual(expect.objectContaining({ detail: 'Binary file, no text diff. '
      + `Working tree: 4 bytes, SHA-256 ${sha(mine)}. BASE: absent.` }))
    expect(await of(Buffer.from('plain text\n'), mine)).toEqual(expect.objectContaining({ kind: 'binary',
      detail: expect.stringContaining('The working tree file differs from BASE.') }))
    // A side that came as decoded text with a replacement character lost its bytes: no hash is better than a wrong one.
    expect(await of('\u0089PNG\uFFFD', mine)).toEqual(expect.objectContaining({ detail: 'Binary file, no text diff. '
      + `Working tree: 4 bytes, SHA-256 ${sha(mine)}. BASE: size and SHA-256 not known, it was read as text.` }))
  })

  it('builds a 611-line added file without calling the general executor', async () => {
    const current = Array.from({ length: 611 }, (_, index) => `line ${index + 1}`).join('\n')
    const result = await new FileDiffBuilder({
      async execute() { throw new Error('An added file called the executor') },
    }).build({
      status: 'untracked',
      completeness: 'full',
      detail: null,
      baseline: { label: 'HEAD', path: 'x', content: null },
      current: { label: 'Current', path: 'x', content: current },
    })

    expect(result).toEqual(expect.objectContaining({
      kind: 'text',
      data: expect.objectContaining({
        baseline: expect.objectContaining({ exists: false }),
        current: expect.objectContaining({ exists: true }),
        hunks: [{
          beforeStart: 1,
          beforeLines: 0,
          afterStart: 1,
          afterLines: 611,
          lines: expect.arrayContaining([
            { kind: 'add', text: 'line 1', beforeLine: null, afterLine: 1 },
            { kind: 'add', text: 'line 611', beforeLine: null, afterLine: 611 },
          ]),
        }],
      }),
    }))
  })

  it('builds deleted lines and identical normalized text without calling the executor', async () => {
    const builder = new FileDiffBuilder({
      async execute() { throw new Error('A direct diff called the executor') },
    })
    const deleted = await builder.build({
      status: 'deleted',
      completeness: 'full',
      detail: null,
      baseline: { label: 'HEAD', path: 'x', content: 'one\n\n' },
      current: { label: 'Current', path: 'x', content: null },
    })
    expect(deleted).toEqual(expect.objectContaining({
      kind: 'text',
      data: expect.objectContaining({
        hunks: [{
          beforeStart: 1,
          beforeLines: 2,
          afterStart: 1,
          afterLines: 0,
          lines: [
            { kind: 'remove', text: 'one', beforeLine: 1, afterLine: null },
            { kind: 'remove', text: '', beforeLine: 2, afterLine: null },
          ],
        }],
      }),
    }))
    expect(await builder.build({
      status: 'modified',
      completeness: 'full',
      detail: null,
      baseline: { label: 'HEAD', path: 'x', content: 'same\r\n' },
      current: { label: 'Current', path: 'x', content: 'same\n' },
    })).toEqual(expect.objectContaining({
      kind: 'text',
      data: expect.objectContaining({
        baseline: expect.objectContaining({ eol: 'crlf' }),
        current: expect.objectContaining({ eol: 'lf' }),
        hunks: [],
      }),
    }))
  })

  it('preserves empty lines and final-newline metadata on both one-sided paths', async () => {
    const builder = new FileDiffBuilder({
      async execute() { throw new Error('A one-sided diff called the executor') },
    })
    for (const sample of [
      { content: '', lines: [], eol: 'none', finalNewline: false },
      { content: '\n', lines: [''], eol: 'lf', finalNewline: true },
      { content: 'one', lines: ['one'], eol: 'none', finalNewline: false },
      { content: 'one\n', lines: ['one'], eol: 'lf', finalNewline: true },
    ] as const) {
      for (const direction of ['add', 'remove'] as const) {
        const result = await builder.build({
          status: direction === 'add' ? 'untracked' : 'deleted',
          completeness: 'full',
          detail: null,
          baseline: {
            label: 'HEAD',
            path: 'x',
            content: direction === 'add' ? null : sample.content,
          },
          current: {
            label: 'Current',
            path: 'x',
            content: direction === 'add' ? sample.content : null,
          },
        })
        if (!result.ok || result.kind !== 'text')
          throw new Error(`The ${direction} sample did not produce text`)
        const version = direction === 'add' ? result.data.current : result.data.baseline
        expect(version).toEqual(expect.objectContaining({
          eol: sample.eol,
          finalNewline: sample.finalNewline,
        }))
        expect(result.data.hunks.flatMap((hunk) => hunk.lines)).toEqual(
          sample.lines.map((text, index) => direction === 'add'
            ? { kind: 'add', text, beforeLine: null, afterLine: index + 1 }
            : { kind: 'remove', text, beforeLine: index + 1, afterLine: null }),
        )
      }
    }
  })
})
