import { createHash } from 'node:crypto'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ContentHashCache } from './svnContentHash'
import { SvnIgnoreRules } from './svnIgnoreRules'
import { SvnPathStates } from './svnPathStates'

const sha1 = (text: string) => createHash('sha1').update(text).digest('hex')

describe('ContentHashCache', () => {
  let dir = ''
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'svn-hash-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('hashes raw bytes, or with every CRLF and lone CR read as LF', () => {
    const file = join(dir, 'a.txt')
    writeFileSync(file, 'one\r\ntwo\rthree\n\r')
    const cache = new ContentHashCache()
    expect(cache.sha1(file, statSync(file, { bigint: true }), false)).toBe(sha1('one\r\ntwo\rthree\n\r'))
    expect(cache.sha1(file, statSync(file, { bigint: true }), true)).toBe(sha1('one\ntwo\nthree\n\n'))
  })

  it('keeps a CRLF split across the read chunk as one line end', () => {
    const file = join(dir, 'big.txt')
    const head = 'x'.repeat((1 << 20) - 1)
    writeFileSync(file, `${head}\r\ny\r`)
    const cache = new ContentHashCache()
    expect(cache.sha1(file, statSync(file, { bigint: true }), true)).toBe(sha1(`${head}\ny\n`))
  })

  it('reads a file once per time and size, and forgets the oldest entry past its bound', () => {
    const file = join(dir, 'a.txt')
    writeFileSync(file, 'a')
    const cache = new ContentHashCache()
    const stats = statSync(file, { bigint: true })
    cache.sha1(file, stats, false)
    cache.sha1(file, stats, false)
    expect(cache.reads).toBe(1)
    for (let index = 0; index < ContentHashCache.entriesConst; index++)
      cache.sha1(file, { ...stats, mtimeNs: BigInt(index + 1) } as typeof stats, false)
    expect(cache.size).toBe(ContentHashCache.entriesConst)
    cache.sha1(file, stats, false)
    expect(cache.reads).toBe(ContentHashCache.entriesConst + 2)
  })
})

describe('SvnPathStates', () => {
  const ignores = new SvnIgnoreRules([])

  it('answers outside for a path below no working copy', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'svn-outside-'))
    try {
      const path = join(dir, 'a.txt')
      expect(new SvnPathStates({ ignores }).read(dir, [path]).get(path)?.state).toEqual({ kind: 'outside' })
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('holds no await between opening and closing wc.db', () => {
    const source = readFileSync(join(import.meta.dirname, 'svnWcDb.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
    expect(source).not.toMatch(/\bawait\b|\basync\b|\.then\(/)
  })
})
