import { afterEach, describe, expect, it, vi } from 'vitest'

import { CommandInvoker } from '../shared/commandInvoker'
import { SvnInvoker } from './svnInvoker'

describe('lib-orchestrator/svn/svnInvoker', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

  it('uses the command invoker with English output and no editor or SSH override', async () => {
    vi.stubEnv('SVN_EDITOR', 'editor')
    vi.stubEnv('SVN_SSH', 'ssh')
    const run = vi.spyOn(CommandInvoker.prototype, 'run').mockResolvedValue({
      code: 0, stdout: '', stderr: '', failure: null,
    })

    await new SvnInvoker().run('C:/work', ['status'])

    const invocation = run.mock.calls[0][0]
    expect(invocation).toMatchObject({ command: 'svn', cwd: 'C:/work', args: ['status'] })
    expect(invocation.env).toMatchObject({ LC_ALL: 'C', LANG: 'C' })
    expect(invocation.env).not.toHaveProperty('SVN_EDITOR')
    expect(invocation.env).not.toHaveProperty('SVN_SSH')
  })
  it('makes write commands noninteractive and forwards streaming controls', async () => {
    const run = vi.spyOn(CommandInvoker.prototype, 'run').mockResolvedValue({ code: 0, stdout: '', stderr: '', failure: null })
    const signal = new AbortController().signal
    await new SvnInvoker().run('C:/work', ['update', '--', '.'], { signal, timeoutMs: 1234, retain: { tailBytes: 100 } })
    expect(run.mock.calls[0][0]).toMatchObject({ args: ['--non-interactive', 'update', '--', '.'], signal, timeoutMs: 1234,
      retain: { tailBytes: 100 } })
  })

  it.each([['ci', '--', '--non-interactive'], ['--username', 'person', 'up', '--', '.'], ['co', 'url', 'folder']])(
    'makes aliases and global options noninteractive without mistaking targets for options: %j', async (...args) => {
      const run = vi.spyOn(CommandInvoker.prototype, 'run').mockResolvedValue({ code: 0, stdout: '', stderr: '', failure: null })
      await new SvnInvoker().run('C:/work', args)
      expect(run.mock.calls[0][0].args).toEqual(['--non-interactive', ...args])
    })

})
