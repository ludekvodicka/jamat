import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommandInvoker } from './commandInvoker'
import { TortoiseCommitDialog } from './tortoiseCommitDialog'

describe('lib-orchestrator/shared/tortoiseCommitDialog', () => {
  afterEach(() => vi.unstubAllEnvs())

  it.each(['svn', 'git'] as const)('opens %s with literal paths, a message file and the human Git environment', async (vcs) => {
    vi.stubEnv('GIT_AUTHOR_NAME', 'inherited bot')
    vi.stubEnv('GIT_DIR', 'another repository')
    const closed = Promise.resolve()
    const launchInteractive = vi.fn<CommandInvoker['launchInteractive']>(async () => ({ ok: true, closed }))
    const dialog = new TortoiseCommitDialog({ platform: 'win32', exists: () => true, commands: { launchInteractive } })
    expect(await dialog.open({ vcs, scope: 'Q:/app with spaces', messageFile: 'Q:/temp/message.txt' })).toEqual({ ok: true, closed })
    expect(launchInteractive).toHaveBeenCalledExactlyOnceWith({
      command: vcs === 'svn' ? TortoiseCommitDialog.svnToolConst : TortoiseCommitDialog.gitToolConst,
      cwd: 'Q:/app with spaces', args: ['/command:commit', '/path:Q:/app with spaces', '/logmsgfile:Q:/temp/message.txt'], env: expect.any(Object),
    })
    expect(Object.keys(launchInteractive.mock.calls[0][0].env).some((key) => key.startsWith('GIT_'))).toBe(false)
  })

  it.each(['linux', 'missing'] as const)('reports %s without spawning', async (state) => {
    const launchInteractive = vi.fn()
    const dialog = new TortoiseCommitDialog({ platform: state === 'linux' ? 'linux' : 'win32', exists: () => false, commands: { launchInteractive } })
    expect(await dialog.open({ vcs: 'svn', scope: 'Q:/app', messageFile: null }))
      .toEqual({ ok: false, detail: `Tortoise commit dialog is unavailable: ${TortoiseCommitDialog.svnToolConst}` })
    expect(launchInteractive).not.toHaveBeenCalled()
  })
})
