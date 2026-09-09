import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ConfigStore } from '../../../lib-orchestrator/configStore/configStore'
import type { ConfigOpResult } from '../../../lib-orchestrator/configStore/configStore.types'
import type { AppClientUiIpcInvokeMap } from '../../shared/appClientUiIpc'
import type { WorktreeSettingsValue } from '../../shared/worktreeSettings'
import { ServiceWorktreeSettingsIpc } from './serviceWorktreeSettingsIpc'

const ipcMainMock = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) =>
      ipcMainMock.handlers.set(channel, handler),
  },
}))

describe('app-client-ui/app/worktrees/serviceWorktreeSettingsIpc', () => {
  const storedConst: WorktreeSettingsValue = { node: { pnpm: { globalVirtualStore: false } } }
  const created: string[] = []
  const authorized = new Set<string>()
  let answer: ConfigOpResult
  let written: WorktreeSettingsValue[]

  beforeEach(() => {
    ipcMainMock.handlers.clear()
    authorized.clear()
    answer = { ok: true }
    written = []
    new ServiceWorktreeSettingsIpc({
      readSection: () => storedConst,
      saveSection: (_spec: unknown, value: WorktreeSettingsValue) => {
        written.push(value)
        return answer
      },
    } as unknown as ConfigStore, async (candidate) => (
      typeof candidate === 'string' && authorized.has(candidate) && existsSync(candidate)
        ? candidate
        : null
    )).initialize()
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

  async function invoke(
    channel: keyof AppClientUiIpcInvokeMap,
    ...args: unknown[]
  ): Promise<unknown> {
    const handler = ipcMainMock.handlers.get(channel)
    if (!handler) throw new Error(`No handler for ${channel}`)
    return handler({} as IpcMainInvokeEvent, ...args)
  }

  it('reads and writes only its config section', async () => {
    expect(await invoke('worktrees:settings-get')).toEqual({ ok: true, value: storedConst })
    const on = { node: { pnpm: { globalVirtualStore: true } } }
    expect(await invoke('worktrees:settings-save', on))
      .toEqual({ ok: true, value: { ok: true } })
    expect(written).toEqual([on])
  })

  it('returns a strict section refusal as domain data', async () => {
    answer = { ok: false, code: 'invalid-section', detail: 'globalVirtualStore' }
    expect(await invoke('worktrees:settings-save', { node: { pnpm: { globalVirtualStore: 1 } } }))
      .toEqual({
        ok: true,
        value: { ok: false, code: 'invalid-section', detail: 'globalVirtualStore' },
      })
  })

  /* No file and a file with no `setup` key are the same answer: this project declares nothing. */
  it('reads a project that declares nothing as null, however it declares it', async () => {
    expect(await invoke('worktrees:project-setup-get', project()))
      .toEqual({ ok: true, value: { ok: true, setup: null } })
    expect(await invoke('worktrees:project-setup-get', project('{"dev":["pnpm dev"]}')))
      .toEqual({ ok: true, value: { ok: true, setup: null } })
  })

  it('reads the setup a project declares', async () => {
    const root = project('{"setup":["pnpm install"]}')
    expect(await invoke('worktrees:project-setup-get', root))
      .toEqual({ ok: true, value: { ok: true, setup: ['pnpm install'] } })
  })

  it('reports a file it could not read rather than answering with a value', async () => {
    const answered = await invoke('worktrees:project-setup-get', project('{ not json'))
    expect(answered).toMatchObject({ ok: true, value: { ok: false } })
    expect((answered as { value: { problem: string } }).value.problem).toContain('.worktree.json')
  })

  /* The custodian's own rule, checked here because this is the caller that will meet it. */
  it('writes setup and leaves every other key of the file alone', async () => {
    const root = project('{"dev":["pnpm dev"],"cleanup":["rm -rf out"]}')
    expect(await invoke('worktrees:project-setup-save', root, ['pnpm install']))
      .toEqual({ ok: true, value: { ok: true } })
    expect(JSON.parse(readFileSync(join(root, '.worktree.json'), 'utf8'))).toEqual({
      dev: ['pnpm dev'],
      cleanup: ['rm -rf out'],
      setup: ['pnpm install'],
    })
  })

  it('creates the file for a project that had none', async () => {
    const root = project()
    expect(await invoke('worktrees:project-setup-save', root, []))
      .toEqual({ ok: true, value: { ok: true } })
    expect(JSON.parse(readFileSync(join(root, '.worktree.json'), 'utf8'))).toEqual({ setup: [] })
  })

  it('refuses to write over a file it could not parse', async () => {
    const root = project('{ not json')
    expect(await invoke('worktrees:project-setup-save', root, ['pnpm install']))
      .toMatchObject({ ok: true, value: { ok: false } })
    expect(readFileSync(join(root, '.worktree.json'), 'utf8')).toBe('{ not json')
  })

  it('refuses foreign and stale paths before reading or writing a project file', async () => {
    const foreign = mkdtempSync(join(tmpdir(), 'jamat-v3-worktrees-foreign-'))
    created.push(foreign)
    const stale = project()
    rmSync(stale, { recursive: true, force: true })

    for (const candidate of [foreign, stale, 42]) {
      expect(await invoke('worktrees:project-setup-get', candidate)).toEqual({
        ok: true,
        value: { ok: false, problem: 'The selected project is no longer in the AppJamatV3 catalog' },
      })
      expect(await invoke('worktrees:project-setup-save', candidate, ['touch escaped'])).toEqual({
        ok: true,
        value: { ok: false, problem: 'The selected project is no longer in the AppJamatV3 catalog' },
      })
    }
    expect(existsSync(join(foreign, '.worktree.json'))).toBe(false)
  })
})
