import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { SvnWcStamp } from './svnWcStamp'

describe('lib-orchestrator/svn/svnWcStamp', () => {
  let temporary: string

  beforeEach(async () => { temporary = await mkdtemp(join(tmpdir(), 'jamat-wc-stamp-')) })
  afterEach(async () => { await rm(temporary, { recursive: true, force: true }) })

  it('finds the working copy that holds a directory, and none outside one', async () => {
    await mkdir(join(temporary, 'wc', '.svn'), { recursive: true })
    await mkdir(join(temporary, 'wc', 'project', 'src'), { recursive: true })
    expect(await SvnWcStamp.rootOf(join(temporary, 'wc', 'project', 'src'))).toBeNull()
    await writeFile(join(temporary, 'wc', '.svn', 'wc.db'), 'db')
    expect(await SvnWcStamp.rootOf(join(temporary, 'wc', 'project', 'src'))).toBe(join(temporary, 'wc'))
  })

  it('changes when a database of any root is written and stays while nothing writes', async () => {
    for (const root of ['wc', join('wc', 'lib')]) {
      await mkdir(join(temporary, root, '.svn'), { recursive: true })
      await writeFile(join(temporary, root, '.svn', 'wc.db'), 'db')
    }
    const roots = [join(temporary, 'wc'), join(temporary, 'wc', 'lib')]
    const first = await SvnWcStamp.of(roots)
    expect(await SvnWcStamp.of(roots)).toBe(first)
    await utimes(join(temporary, 'wc', 'lib', '.svn', 'wc.db'), new Date(2_000_000), new Date(2_000_000))
    expect(await SvnWcStamp.of(roots)).not.toBe(first)
    const second = await SvnWcStamp.of(roots)
    await writeFile(join(temporary, 'wc', '.svn', 'wc.db-wal'), 'pending')
    expect(await SvnWcStamp.of(roots)).not.toBe(second)
  })
})
