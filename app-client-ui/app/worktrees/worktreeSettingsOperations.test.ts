import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ConfigStore } from '../../../lib-orchestrator/configStore/configStore'
import type { ConfigOpResult } from '../../../lib-orchestrator/configStore/configStore.types'
import type { WorktreeSettingsValue } from '../../shared/worktreeSettings'
import { RegistryBench } from '../remoteControl/fixtures/registryBench'
import { WorktreeSettingsOperations } from './worktreeSettingsOperations'

describe('app-client-ui/app/worktrees/worktreeSettingsOperations', () => {
  const storedConst: WorktreeSettingsValue = { node: { pnpm: { globalVirtualStore: false } } }
  const created: string[] = []
  const authorized = new Set<string>()
  let answer: ConfigOpResult
  let written: WorktreeSettingsValue[]
  let bench: RegistryBench

  beforeEach(() => {
    bench = new RegistryBench()
    authorized.clear()
    answer = { ok: true }
    written = []
    new WorktreeSettingsOperations({
      readSection: () => storedConst,
      saveSection: (_spec: unknown, value: WorktreeSettingsValue) => {
        written.push(value)
        return answer
      },
    } as unknown as ConfigStore, async (candidate) => (
      typeof candidate === 'string' && authorized.has(candidate) && existsSync(candidate)
        ? candidate
        : null
    )).register(bench.registry)
  })

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  function project(worktreeJson?: string): string {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-worktrees-ipc-'))
    created.push(root)
    authorized.add(root)
    mkdirSync(root, { recursive: true })
    if (worktreeJson !== undefined)
      writeFileSync(join(root, '.worktree.json'), worktreeJson, 'utf8')
    return root
  }

  const read = (projectPath: string) => bench.call('projectSetup.get', { projectPath })
  const write = (projectPath: string, setup: string[]) => bench.call('projectSetup.save', { projectPath, setup })
  const problem = (detail: string) => ({ ok: false, error: { code: 'operation-failed', detail, data: { sourceCode: 'project-setup' } } })
  const refusalConst = 'The selected project is no longer in the AppJamatV3 catalog'

  it('reads and writes only its config section', async () => {
    expect(await bench.call('worktreeSettings.get')).toEqual({ ok: true, value: storedConst })
    const on = { node: { pnpm: { globalVirtualStore: true } } }
    expect(await bench.call('worktreeSettings.save', { value: on })).toEqual({ ok: true, value: {} })
    expect(written).toEqual([on])
  })

  it('returns a strict section refusal with its own code', async () => {
    answer = { ok: false, code: 'invalid-section', detail: 'globalVirtualStore' }
    expect(await bench.call('worktreeSettings.save', { value: { node: { pnpm: { globalVirtualStore: 1 } } } }))
      .toEqual({ ok: false, error: { code: 'operation-failed', detail: 'globalVirtualStore', data: { sourceCode: 'invalid-section' } } })
  })

  /* No file and a file with no `setup` key are the same answer: this project declares nothing. */
  it('reads a project that declares nothing as null, however it declares it', async () => {
    expect(await read(project())).toEqual({ ok: true, value: { setup: null } })
    expect(await read(project('{"dev":["pnpm dev"]}'))).toEqual({ ok: true, value: { setup: null } })
  })

  it('reads the setup a project declares', async () => {
    const root = project('{"setup":["pnpm install"]}')
    expect(await read(root)).toEqual({ ok: true, value: { setup: ['pnpm install'] } })
  })

  it('reports a file it could not read rather than answering with a value', async () => {
    const answered = await read(project('{ not json'))
    expect(answered).toMatchObject({ ok: false, error: { data: { sourceCode: 'project-setup' } } })
    expect(answered.ok ? '' : answered.error.detail).toContain('.worktree.json')
  })

  /* The custodian's own rule, checked here because this is the caller that will meet it. */
  it('writes setup and leaves every other key of the file alone', async () => {
    const root = project('{"dev":["pnpm dev"],"cleanup":["rm -rf out"]}')
    expect(await write(root, ['pnpm install'])).toEqual({ ok: true, value: {} })
    expect(JSON.parse(readFileSync(join(root, '.worktree.json'), 'utf8'))).toEqual({
      dev: ['pnpm dev'],
      cleanup: ['rm -rf out'],
      setup: ['pnpm install'],
    })
  })

  it('creates the file for a project that had none', async () => {
    const root = project()
    expect(await write(root, [])).toEqual({ ok: true, value: {} })
    expect(JSON.parse(readFileSync(join(root, '.worktree.json'), 'utf8'))).toEqual({ setup: [] })
  })

  it('refuses to write over a file it could not parse', async () => {
    const root = project('{ not json')
    expect(await write(root, ['pnpm install'])).toMatchObject({ ok: false })
    expect(readFileSync(join(root, '.worktree.json'), 'utf8')).toBe('{ not json')
  })

  it('refuses foreign and stale paths before reading or writing a project file', async () => {
    const foreign = mkdtempSync(join(tmpdir(), 'jamat-v3-worktrees-foreign-'))
    created.push(foreign)
    const stale = project()
    rmSync(stale, { recursive: true, force: true })

    for (const candidate of [foreign, stale]) {
      expect(await read(candidate)).toEqual(problem(refusalConst))
      expect(await write(candidate, ['touch escaped'])).toEqual(problem(refusalConst))
    }
    // A path that is not text never reaches the catalog: the body schema refuses it.
    expect(await bench.call('projectSetup.get', { projectPath: 42 })).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    expect(existsSync(join(foreign, '.worktree.json'))).toBe(false)
  })
})
