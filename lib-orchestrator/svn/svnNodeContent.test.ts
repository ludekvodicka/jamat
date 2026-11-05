import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { SvnNodeContent } from './svnNodeContent'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

describe('lib-orchestrator/svn/svnNodeContent', () => {
  it('hashes empty, buffer-sized and larger files read concurrently through shared buffers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jamat-node-content-'))
    roots.push(root)
    const contents = [Buffer.alloc(0), Buffer.alloc(65_536, 1), Buffer.alloc(200_003, 2), Buffer.from('short\r\n')]
    const files = await Promise.all(contents.map(async (content, index) => {
      const file = join(root, `file-${index}`)
      await writeFile(file, content)
      return file
    }))

    const hashes = await Promise.all([...files, ...files].map((file) => SvnNodeContent.hash(file)))

    const expected = contents.map((content) => createHash('sha256').update(content).digest('hex'))
    expect(hashes).toEqual([...expected, ...expected])
    await expect(SvnNodeContent.hash(join(root, 'missing'))).rejects.toThrow('ENOENT')
  })
})
