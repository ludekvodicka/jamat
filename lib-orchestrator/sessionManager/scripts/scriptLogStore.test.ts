import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ScriptLogStore } from './scriptLogStore'

describe('lib-orchestrator/sessionManager/scripts/scriptLogStore', () => {
  let root: string
  let directory: string
  let store: ScriptLogStore

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'jamat-script-logs-'))
    directory = join(root, 'script-logs')
    store = new ScriptLogStore(directory)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('places a log at <directory>/<parentId>/<runId>.log', () => {
    expect(store.pathOf('parent-1', 'run-1')).toBe(join(directory, 'parent-1', 'run-1.log'))
  })

  it.each(['..', '../x', 'a/b', 'a\\b', 'C:x', '', 'a b', 'x.log'])('refuses the id %j', (id) => {
    expect(() => store.pathOf(id, 'run-1')).toThrow(/Not a plain id/)
    expect(() => store.pathOf('parent-1', id)).toThrow(/Not a plain id/)
  })

  it('writes the text as UTF-8 and reads it back, leaving no temp file', async () => {
    const text = 'Script:    Setup\nžluťoučký kůň\n'
    expect(await store.write('parent-1', 'run-1', text)).toEqual({ ok: true, bytes: Buffer.byteLength(text, 'utf8') })

    expect(readFileSync(store.pathOf('parent-1', 'run-1'), 'utf8')).toBe(text)
    expect(readdirSync(join(directory, 'parent-1'))).toEqual(['run-1.log'])
    expect(await store.read('parent-1', 'run-1', 1_000_000)).toEqual({ text, truncated: false })
  })

  it('replaces an earlier log of the same run whole', async () => {
    await store.write('parent-1', 'run-1', 'first\n')
    await store.write('parent-1', 'run-1', 'second\n')

    expect(await store.read('parent-1', 'run-1', 1_000)).toEqual({ text: 'second\n', truncated: false })
  })

  it('answers a write it refused instead of throwing', async () => {
    const result = await store.write('../escape', 'run-1', 'text')

    expect(result.ok).toBe(false)
    expect(existsSync(join(root, 'escape'))).toBe(false)
  })

  it('reads only the last maxBytes and drops the cut first line', async () => {
    await store.write('parent-1', 'run-1', 'header\nrow 1\nrow 2\n')

    expect(await store.read('parent-1', 'run-1', 9)).toEqual({ text: 'row 2\n', truncated: true })
  })

  it('reads null for a missing log and for an id that is not plain', async () => {
    expect(await store.read('parent-1', 'run-1', 1_000)).toBeNull()
    expect(await store.read('..', 'run-1', 1_000)).toBeNull()
  })

  it('answers the path of a log on disk only, and null for anything else', async () => {
    expect(await store.existingPathOf('parent-1', 'run-1')).toBeNull()
    await store.write('parent-1', 'run-1', 'one')
    expect(await store.existingPathOf('parent-1', 'run-1')).toBe(store.pathOf('parent-1', 'run-1'))
    mkdirSync(store.pathOf('parent-1', 'run-dir'))
    expect(await store.existingPathOf('parent-1', 'run-dir')).toBeNull()
    expect(await store.existingPathOf('..', 'run-1')).toBeNull()
    expect(await store.existingPathOf('parent-1', '../run-1')).toBeNull()
  })

  it('removes one run, then the whole parent folder', async () => {
    await store.write('parent-1', 'run-1', 'one')
    await store.write('parent-1', 'run-2', 'two')

    await store.removeRun('parent-1', 'run-1')
    expect(readdirSync(join(directory, 'parent-1'))).toEqual(['run-2.log'])

    await store.removeParent('parent-1')
    expect(existsSync(join(directory, 'parent-1'))).toBe(false)
    await store.removeParent('parent-1')
  })

  it('sweeps the old folders of unknown parents and reports the count', async () => {
    await store.write('parent-1', 'run-1', 'kept')
    await store.write('parent-2', 'run-1', 'gone')
    await store.write('parent-3', 'run-1', 'gone')
    await store.write('parent-5', 'run-1', 'kept: changed after the cut')
    writeFileSync(join(directory, 'stray.txt'), 'not a folder')
    mkdirSync(join(directory, 'parent-4'))
    for (const parent of ['parent-1', 'parent-2', 'parent-3', 'parent-4'])
      utimesSync(join(directory, parent), 1, 1)

    expect(await store.sweep(new Set(['parent-1']), 10_000)).toBe(3)
    expect(readdirSync(directory).sort()).toEqual(['parent-1', 'parent-5', 'stray.txt'])
  })

  it('sweeps nothing when no log was ever written', async () => {
    expect(await store.sweep(new Set(), Date.now())).toBe(0)
  })
})
