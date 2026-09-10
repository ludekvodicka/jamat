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
})
