import { ChildProcess, type spawn } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { CommitAsideLauncher } from './commitAsideLauncher'

describe('app-client-cli/app/commitAsideLauncher', () => {
  it.each(['svn', 'git'] as const)('starts detached %s with a message file and waits only for spawn', async (vcs) => {
    const child = new ChildProcess()
    const unref = vi.spyOn(child, 'unref')
    const launch = vi.fn(() => { queueMicrotask(() => child.emit('spawn')); return child })
    const launcher = new CommitAsideLauncher({ platform: 'win32', exists: () => true, spawn: launch as unknown as typeof spawn })
    expect(await launcher.open({ vcs, scope: 'Q:/app with spaces', messageFile: 'Q:/temp/message.txt', reason: 'jamat-unavailable' }))
      .toMatchObject({ ok: true, value: { kind: 'opened-aside' } })
    expect(launch).toHaveBeenCalledWith(vcs === 'svn' ? CommitAsideLauncher.svnToolConst : CommitAsideLauncher.gitToolConst,
      ['/command:commit', '/path:Q:/app with spaces', '/logmsgfile:Q:/temp/message.txt'], { detached: true, stdio: 'ignore', windowsHide: true })
    expect(unref).toHaveBeenCalledOnce()
  })

  it.each(['linux', 'missing'] as const)('reports %s without spawning', async (state) => {
    const launch = vi.fn()
    const launcher = new CommitAsideLauncher({ platform: state === 'linux' ? 'linux' : 'win32', exists: () => false, spawn: launch })
    expect(await launcher.open({ vcs: 'svn', scope: 'Q:/app', messageFile: null, reason: 'session-not-open' }))
      .toMatchObject({ ok: false, error: { code: 'unavailable', detail: expect.stringContaining(CommitAsideLauncher.svnToolConst) } })
    expect(launch).not.toHaveBeenCalled()
  })
})
