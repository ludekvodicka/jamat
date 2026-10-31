import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

import { RemoteLauncherConfig } from './remoteLauncherConfig'
import { launcherProcess } from './remoteLauncherRecipe'
import { inspectLauncherProcess } from './remoteLauncherProcess'

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

it('preserves old configuration recipes and rejects unknown fields and relative paths', () => {
  const root = tmpdir()
  const envelope = { publicUrl: 'http://127.0.0.1:3511', key: 'a'.repeat(64), configDir: root,
    configIdentity: 'profile', runtimeChannel: 'development', logFile: join(root, 'launcher.log') }
  for (const recipe of [
    { kind: 'executable', path: process.execPath }, { kind: 'source', repositoryRoot: root },
    { kind: 'development', repositoryRoot: root },
    ...['command', 'detached-command'].map(kind => ({ kind, command: process.execPath, args: ['a b'], cwd: root, windowsVerbatimArguments: false })),
  ]) {
    expect(RemoteLauncherConfig.parse({ ...envelope, recipe }).recipe).toEqual(recipe)
    expect(() => RemoteLauncherConfig.recipe({ ...recipe, extra: true })).toThrow()
  }
  expect(() => RemoteLauncherConfig.recipe({ kind: 'development', repositoryRoot: 'relative' })).toThrow()
  expect(() => RemoteLauncherConfig.recipe({ kind: 'new-kind', path: process.execPath })).toThrow()
})

it('uses detached development startup with a longer budget while preserving production and build behavior', () => {
  const root = join(tmpdir(), 'checkout with spaces')
  const dev = launcherProcess({ kind: 'development', repositoryRoot: root }, process.execPath)
  expect(dev).toMatchObject({ command: process.execPath, cwd: join(root, 'app-client-ui'),
    args: [join(root, 'app-client-ui/node_modules/electron-vite/bin/electron-vite.js'), 'dev'],
    completion: 'spawn', requireRunning: true, readinessTimeoutMs: 150_000 })
  expect(launcherProcess({ kind: 'executable', path: process.execPath }, process.execPath))
    .toMatchObject({ completion: 'spawn', readinessTimeoutMs: 60_000, requireRunning: false })
  expect(launcherProcess({ kind: 'source', repositoryRoot: root }, process.execPath))
    .toMatchObject({ completion: 'exit-zero', readinessTimeoutMs: 60_000 })
})

it('checks required file types and cwd without executing the command', async () => {
  const root = await mkdtemp(join(tmpdir(), 'launcher-paths-'))
  directories.push(root)
  const file = join(root, 'program.exe')
  const plan = launcherProcess({ kind: 'executable', path: file }, process.execPath)
  expect(await inspectLauncherProcess(plan)).toEqual({ state: 'missing', path: file })
  await mkdir(file)
  expect(await inspectLauncherProcess(plan)).toEqual({ state: 'invalid', path: file })
  await rm(file, { recursive: true })
  await writeFile(file, 'not executable; inspection must not run this')
  expect(await inspectLauncherProcess(plan)).toEqual({ state: 'available' })
  expect(await inspectLauncherProcess({ ...plan, cwd: file })).toEqual({ state: 'invalid', path: file })
})
