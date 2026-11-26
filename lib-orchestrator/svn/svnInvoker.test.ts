import { afterEach, describe, expect, it, vi } from 'vitest'

import { CommandInvoker } from '../shared/commandInvoker'
import { SvnExecutable } from './svnExecutable'
import { SvnInvoker } from './svnInvoker'

describe('lib-orchestrator/svn/svnInvoker', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

  it('labels the subcommand without its path or global option values', async () => {
    const run = vi.spyOn(CommandInvoker.prototype, 'run').mockResolvedValue({ code: 0, stdout: '', stderr: '', failure: null })
    await new SvnInvoker().run(import.meta.dirname, ['--username', 'private-person', 'update', 'Q:/private/project'])
    expect(run.mock.lastCall![0].perfName).toBe('svn:update')
  })

  it('uses the resolved svn executable with English output, DLL path and no editor or SSH override', async () => {
    vi.stubEnv('SVN_EDITOR', 'editor')
    vi.stubEnv('SVN_SSH', 'ssh')
    vi.spyOn(SvnExecutable, 'resolve').mockReturnValue({ command: 'C:/cache/svn-utf8.exe', dllDirectory: 'C:/TortoiseSVN/bin', utf8: true })
    const run = vi.spyOn(CommandInvoker.prototype, 'run').mockResolvedValue({
      code: 0, stdout: '', stderr: '', failure: null,
    })

    await new SvnInvoker().run('C:/work', ['status'])

    const invocation = run.mock.calls[0][0]
    expect(invocation).toMatchObject({ command: 'C:/cache/svn-utf8.exe', cwd: 'C:/work', args: ['status'] })
    expect(invocation.env).toMatchObject({ LC_ALL: 'C', LANG: 'C' })
    const pathKey = Object.keys(invocation.env).find((key) => key.toLowerCase() === 'path')!
    expect(invocation.env[pathKey]?.startsWith('C:/TortoiseSVN/bin')).toBe(true)
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
