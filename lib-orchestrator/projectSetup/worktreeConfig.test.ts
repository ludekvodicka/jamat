import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { AtomicJsonFile } from '../shared/atomicJsonFile'
import { WorktreeConfig } from './worktreeConfig'

describe('lib-orchestrator/projectSetup/worktreeConfig', () => {
  const created: string[] = []

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  function project(initial?: unknown): { projectRoot: string; configFile: string } {
    const projectRoot = mkdtempSync(join(tmpdir(), 'jamat-v3-worktree-config-'))
    created.push(projectRoot)
    const configFile = join(projectRoot, '.worktree.json')
    if (initial !== undefined)
      writeFileSync(
        configFile,
        typeof initial === 'string' ? initial : JSON.stringify(initial, null, 2),
        'utf8',
      )
    return { projectRoot, configFile }
  }

  it('reads a missing file as nothing declared', async () => {
    const { projectRoot } = project()
    expect(await WorktreeConfig.read(projectRoot)).toEqual({ ok: true, value: null })
  })

  it('reads a file that declares only other keys as nothing declared', async () => {
    const { projectRoot } = project({ dev: 'pnpm dev' })
    expect(await WorktreeConfig.read(projectRoot)).toEqual({ ok: true, value: null })
  })

  // An empty array is a decision the project made, not the absence of one.
  it('round-trips an explicit empty setup as an empty array', async () => {
    const { projectRoot } = project({ setup: [] })
    expect(await WorktreeConfig.read(projectRoot)).toEqual({ ok: true, value: { setup: [] } })
  })

  it('reads the commands in the order they were written', async () => {
    const { projectRoot } = project({ setup: ['pnpm install', 'pnpm build'] })
    expect(await WorktreeConfig.read(projectRoot))
      .toEqual({ ok: true, value: { setup: ['pnpm install', 'pnpm build'] } })
  })

  it('refuses a file it cannot parse instead of falling back', async () => {
    const { projectRoot } = project('{ "setup": [')
    const read = await WorktreeConfig.read(projectRoot)
    expect(read.ok).toBe(false)
    expect(read).toMatchObject({ problem: expect.stringContaining('not valid JSON') })
  })

  it('refuses a document that is not an object', async () => {
    const { projectRoot } = project(['pnpm install'])
    expect((await WorktreeConfig.read(projectRoot)).ok).toBe(false)
  })

  it('refuses a setup that is not a list of commands', async () => {
    const notAnArray = project({ setup: 'pnpm install' })
    const notStrings = project({ setup: ['pnpm install', 7] })
    const empties = project({ setup: ['  '] })
    expect((await WorktreeConfig.read(notAnArray.projectRoot)).ok).toBe(false)
    expect((await WorktreeConfig.read(notStrings.projectRoot)).ok).toBe(false)
    expect((await WorktreeConfig.read(empties.projectRoot)).ok).toBe(false)
  })

  // Everything else in the file belongs to whoever put it there.
  it('replaces only setup and keeps every other key', async () => {
    const { projectRoot, configFile } = project({
      dev: 'pnpm dev',
      setup: ['npm install'],
      cleanup: ['rm -rf node_modules'],
      somethingNobodyKnows: { deep: [1, 2] },
    })

    expect(await WorktreeConfig.save(projectRoot, ['pnpm install'])).toEqual({ ok: true })
    expect(JSON.parse(readFileSync(configFile, 'utf8'))).toEqual({
      dev: 'pnpm dev',
      setup: ['pnpm install'],
      cleanup: ['rm -rf node_modules'],
      somethingNobodyKnows: { deep: [1, 2] },
    })
  })

  it('writes a new file when the project has none', async () => {
    const { projectRoot, configFile } = project()
    expect(await WorktreeConfig.save(projectRoot, ['uv sync'])).toEqual({ ok: true })
    expect(JSON.parse(readFileSync(configFile, 'utf8'))).toEqual({ setup: ['uv sync'] })
  })

  it('refuses entries that are not commands', async () => {
    const { projectRoot, configFile } = project()
    const written = await WorktreeConfig.save(projectRoot, ['pnpm install', 42 as unknown as string])
    expect(written.ok).toBe(false)
    expect(existsSync(configFile)).toBe(false)
  })

  it('bounds the number and length of setup commands on read and write', async () => {
    const tooMany = Array.from(
      { length: WorktreeConfig.setupCommandsMaxConst + 1 },
      (_, index) => `command ${index}`,
    )
    const tooLong = 'x'.repeat(WorktreeConfig.setupCommandCharactersMaxConst + 1)
    const readMany = project({ setup: tooMany })
    const readLong = project({ setup: [tooLong] })
    const writeTarget = project()

    expect((await WorktreeConfig.read(readMany.projectRoot)).ok).toBe(false)
    expect((await WorktreeConfig.read(readLong.projectRoot)).ok).toBe(false)
    expect((await WorktreeConfig.save(writeTarget.projectRoot, tooMany)).ok).toBe(false)
    expect((await WorktreeConfig.save(writeTarget.projectRoot, [tooLong])).ok).toBe(false)
    expect(existsSync(writeTarget.configFile)).toBe(false)
  })

  /**
   * The file sits in the user's checkout and is meant to be committed, so it is written with the
   * permissions of a checked-in file rather than the owner-only mode everything under the machine
   * state root gets - which on POSIX would re-tighten it to 0600 on every save. The mode argument is
   * asserted because win32 has no permission bits to read back; the comparison against a control
   * file is what proves the mode actually landed, whatever umask the machine runs.
   */
  it('writes the file with the permissions of a checked-in file', async () => {
    const { projectRoot, configFile } = project()
    const write = vi.spyOn(AtomicJsonFile, 'write')
    try {
      expect(await WorktreeConfig.save(projectRoot, ['pnpm install'])).toEqual({ ok: true })
      expect(write).toHaveBeenCalledWith(configFile, { setup: ['pnpm install'] }, 0o644)
    }
    finally { write.mockRestore() }
    if (process.platform !== 'win32') {
      const control = join(projectRoot, 'control.json')
      writeFileSync(control, '{}', { mode: 0o644 })
      expect(statSync(configFile).mode & 0o777).toBe(statSync(control).mode & 0o777)
    }
  })

  // Writing over a file that failed to parse would drop the rest of what the user wrote in it.
  it('refuses to write over a file it could not read', async () => {
    const { projectRoot, configFile } = project('{ "dev": ')
    const rawBefore = readFileSync(configFile, 'utf8')
    const written = await WorktreeConfig.save(projectRoot, ['pnpm install'])
    expect(written.ok).toBe(false)
    expect(readFileSync(configFile, 'utf8')).toBe(rawBefore)
  })
})
