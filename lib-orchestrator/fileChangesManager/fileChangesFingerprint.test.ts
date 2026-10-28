import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { FileChangesFingerprint } from './fileChangesFingerprint'

describe('reviewed file content', () => {
  const roots: string[] = []
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

  it('detects different bytes even when their size and modification time stay equal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jamat-reviewed-content-'))
    roots.push(root)
    const file = join(root, 'selected.txt')
    await writeFile(file, 'first')
    const stamp = await stat(file)
    const reviewed = await FileChangesFingerprint.of(file)
    await writeFile(file, 'other')
    await utimes(file, stamp.atime, stamp.mtime)
    expect(await FileChangesFingerprint.of(file)).not.toBe(reviewed)
    expect(await readFile(file, 'utf8')).toBe('other')
  })

  it('distinguishes a removed file from an empty file and a directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jamat-reviewed-nodes-'))
    roots.push(root)
    const file = join(root, 'selected.txt')
    const missing = await FileChangesFingerprint.of(file)
    await writeFile(file, '')
    expect(await FileChangesFingerprint.of(file)).not.toBe(missing)
    expect(await FileChangesFingerprint.of(root)).not.toBe(missing)
    await rm(file)
    expect(await FileChangesFingerprint.of(file)).toBe(missing)
  })
})
