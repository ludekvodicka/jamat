import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PassInbox } from './passInbox'
import type { PassBrief } from './snapinContract'

describe('PassInbox', () => {
  let root: string
  let directory: string
  let brief: PassBrief
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pass-inbox-'))
    vi.stubEnv('JAMAT_V3_LOCAL_STATE_DIR', root)
    brief = { schema: 1, kind: 'test', attemptId: randomUUID(), mode: 'wc', projectDirectory: root,
      priorAttemptId: null, work: { kind: 'fixture' } }
    directory = join(root, 'orchestrator', 'identity', 'development', 'snapins', 'test', 'passes', brief.attemptId)
  })
  afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) })

  it('checks the path and brief identity before accepting a pass', async () => {
    await PassInbox.create(directory, brief)
    await expect(PassInbox.open(root)).rejects.toThrow('owned')
    await writeFile(join(directory, 'brief.json'), JSON.stringify({ ...brief, attemptId: randomUUID() }))
    await expect(PassInbox.open(directory)).rejects.toThrow('identity')
    expect(await readdir(directory)).toEqual(['brief.json'])
  })

  it('refuses a junction to a directory outside the owned pass', async () => {
    const outside = join(root, 'outside')
    await mkdir(outside)
    await mkdir(join(directory, '..'), { recursive: true })
    await writeFile(join(outside, 'brief.json'), JSON.stringify(brief))
    await symlink(outside, directory, 'junction')
    await expect(PassInbox.open(directory)).rejects.toThrow('redirects')
    expect(await readdir(outside)).toEqual(['brief.json'])
  })

  it('accepts the machine root through an alias while keeping the pass identity', async () => {
    const actual = join(root, 'machine')
    const alias = join(root, 'alias')
    await mkdir(actual)
    await symlink(actual, alias, 'junction')
    vi.stubEnv('JAMAT_V3_LOCAL_STATE_DIR', alias)
    const owned = join(alias, 'orchestrator', 'identity', 'development', 'snapins', 'test', 'passes', brief.attemptId)
    const inbox = await PassInbox.create(owned, brief)
    expect(await inbox.append({ kind: 'working', at: 1 })).toBe(1)
    expect(await (await PassInbox.open(inbox.directory)).after(0)).toEqual([{ n: 1, event: { kind: 'working', at: 1 } }])
    expect(await readdir(join(actual, 'orchestrator', 'identity', 'development', 'snapins', 'test', 'passes', brief.attemptId, 'inbox')))
      .toEqual(['000001.json'])
  })

  it('refuses a pass redirected after opening, without writing to the destination', async () => {
    const inbox = await PassInbox.create(directory, brief)
    const outside = join(root, 'moved-pass')
    await rename(directory, outside)
    await symlink(outside, directory, 'junction')
    await expect(inbox.append({ kind: 'working', at: 1 })).rejects.toThrow('redirects')
    expect(await readdir(outside)).toEqual(['brief.json'])
  })

  it('refuses a redirected inbox without writing to its destination', async () => {
    const inbox = await PassInbox.create(directory, brief)
    const outside = join(root, 'foreign-inbox')
    await mkdir(outside)
    await symlink(outside, join(directory, 'inbox'), 'junction')
    await expect(inbox.append({ kind: 'working', at: 1 })).rejects.toThrow('redirects')
    expect(await readdir(outside)).toEqual([])
  })

  it('publishes twenty concurrent appends without gaps or incomplete visible files', async () => {
    const inbox = await PassInbox.create(directory, brief)
    let done = false
    const writing = Promise.all(Array.from({ length: 20 }, () => inbox.append({ kind: 'working', at: 1 }))).finally(() => { done = true })
    while (!done) {
      const seen = await inbox.after(0)
      expect(seen.map(({ n }) => n)).toEqual(Array.from({ length: seen.length }, (_, i) => i + 1))
      expect(seen.every(({ event }) => event?.kind === 'working')).toBe(true)
    }
    expect((await writing).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
    expect(await readdir(join(directory, 'inbox'))).toHaveLength(20)
    expect(await readFile(join(directory, 'inbox', '000020.json'), 'utf8')).toContain('working')
  })

  it('returns the number of a corrupt final file so it can be skipped', async () => {
    const inbox = await PassInbox.create(directory, brief)
    await inbox.append({ kind: 'working', at: 1 })
    await writeFile(join(directory, 'inbox', '000002.json'), '{')
    expect(await inbox.after(1)).toEqual([{ n: 2, event: null }])
  })

  it('propagates a numbered file read failure instead of advancing over it', async () => {
    const inbox = await PassInbox.create(directory, brief)
    await mkdir(join(directory, 'inbox', '000001.json'), { recursive: true })
    await expect(inbox.after(0)).rejects.toBeDefined()
  })
})
