import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SvnShim } from './svnShim'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
describe('SvnShim', () => {
  it('refuses write aliases after global options and forwards read arguments byte-for-byte', () => {
    const directory = mkdtempSync(join(tmpdir(), 'jamat svn shim '))
    directories.push(directory)
    const shim = SvnShim.ensure(directory)
    const echo = join(directory, 'help')
    writeFileSync(echo, 'console.log(JSON.stringify(process.argv.slice(2)))')
    const run = (args: string[]) => spawnSync(process.execPath, [join(shim, 'svn-shim.cjs'), ...args], {
      encoding: 'utf8', cwd: directory, env: { ...process.env, JAMAT_V3_REAL_SVN: process.execPath },
    })
    for (const command of ['commit', 'ci', 'update', 'up', 'revert', 'propset', 'pset', 'changelist', 'patch', 'upgrade', 'mkdir']) {
      const result = run(['--username', 'status', '--config-dir', 'a path', command, '-m', 'x'])
      expect(result.status).toBe(3)
      expect(result.stderr).toContain(`svn ${command} is refused in a Jamat worktree`)
    }
    // A Node executable stands in for SVN; help consumes its own options but proves read forwarding.
    expect(JSON.parse(run(['help', 'a path', 'x&y']).stdout)).toEqual(['a path', 'x&y'])
    expect(run(['--version']).status).toBe(0)
    expect(run(['--help']).status).toBe(0)
    expect(run(['--username', '--help', 'commit']).status).toBe(3)
    writeFileSync(join(directory, 'add'), 'console.log(JSON.stringify(process.argv.slice(2)))')
    const added = run(['add', '--parents', 'a path'])
    expect(added.status, added.stderr).toBe(0)
    expect(JSON.parse(added.stdout)).toEqual(['--parents', 'a path'])
    const ignored = run(['add', '--no-ignore', 'a path'])
    expect(ignored.status).toBe(3)
    expect(ignored.stderr).toContain('svn add is refused in a Jamat worktree')
    if (process.platform === 'win32') {
      const result = spawnSync('cmd.exe', ['/d', '/s', '/c', '""' + join(shim, 'svn.cmd') + '" --non-interactive up"'], {
        encoding: 'utf8', windowsVerbatimArguments: true, env: { ...process.env, JAMAT_V3_REAL_SVN: process.execPath, JAMAT_V3_SVN_SHIM_NODE: process.execPath },
      })
      expect(result.status).toBe(3)
      expect(result.stderr).toContain('svn up is refused')
      const env = { ...process.env, JAMAT_V3_REAL_SVN: process.execPath.replace(/\\/g, '/'), JAMAT_V3_SVN_SHIM_NODE: process.execPath.replace(/\\/g, '/') }
      const cmdRead = spawnSync('cmd.exe', ['/d', '/s', '/c', '""' + join(shim, 'svn.cmd') + '" help "a path" "x&y""'], {
        cwd: directory, encoding: 'utf8', windowsVerbatimArguments: true, env,
      })
      expect(cmdRead.status, cmdRead.stderr).toBe(0)
      expect(JSON.parse(cmdRead.stdout)).toEqual(['a path', 'x&y'])
      const bashRead = spawnSync('C:/Program Files/Git/bin/bash.exe', [join(shim, 'svn').replace(/\\/g, '/'), 'help', 'a path', 'x&y'], {
        cwd: directory, encoding: 'utf8', env,
      })
      expect(bashRead.status, bashRead.stderr).toBe(0)
      expect(JSON.parse(bashRead.stdout)).toEqual(['a path', 'x&y'])
    }
  })
})
