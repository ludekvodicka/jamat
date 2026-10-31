import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
      encoding: 'utf8', cwd: directory, env: { ...process.env, JAMAT_V3_REAL_SVN: process.execPath, JAMAT_V3_SVN_SHIM_WORKTREE: directory },
    })
    for (const command of ['commit', 'ci', 'update', 'up', 'switch', 'cleanup', 'propset', 'pset', 'changelist', 'patch', 'upgrade', 'mkdir']) {
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

  // A refused move reached the review as a delete plus an add without history (r290).
  it("confines delete, move, copy and revert to paths of the worker's own worktree", () => {
    const directory = mkdtempSync(join(tmpdir(), 'jamat svn shim '))
    directories.push(directory)
    const shim = SvnShim.ensure(directory)
    const worktree = join(directory, 'tree')
    const outside = join(directory, 'outside')
    mkdirSync(join(worktree, 'sub'), { recursive: true })
    mkdirSync(outside)
    symlinkSync(outside, join(worktree, 'link'), 'junction')
    // A Node executable stands in for SVN: it runs the script named by the command word and echoes the rest.
    for (const command of ['rm', 'delete', 'mv', 'cp', 'revert'])
      writeFileSync(join(worktree, command), 'console.log(JSON.stringify(process.argv.slice(2)))')
    writeFileSync(join(worktree, 'inside.txt'), 'a.txt\r\nsub\r\n\r\n')
    writeFileSync(join(worktree, 'escape.txt'), 'a.txt\n../outside.txt\n')
    const run = (args: readonly string[], env: Record<string, string> = { JAMAT_V3_SVN_SHIM_WORKTREE: worktree }) =>
      spawnSync(process.execPath, [join(shim, 'svn-shim.cjs'), ...args], { encoding: 'utf8', cwd: worktree,
        env: { ...process.env, JAMAT_V3_REAL_SVN: process.execPath, ...env } })
    for (const args of [['rm', 'a.txt'], ['delete', '--non-interactive', '--keep-local', '-q', 'sub/b.txt'],
      ['mv', '--parents', '--allow-mixed-revisions', 'a.txt', 'sub/new/a.txt'], ['cp', '-r5', 'a.txt@5', 'c.txt'],
      ['revert', '-R', '.'], ['revert', '--depth=infinity', '--targets', 'inside.txt'], ['rm', join(worktree, 'sub', 'b.txt')]]) {
      const result = run(args)
      expect(result.status, `${args.join(' ')}: ${result.stderr}`).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual(args.slice(args.findIndex((arg) => !arg.startsWith('-')) + 1))
    }
    for (const [args, reason] of [
      [['rm', '../outside/a.txt'], 'is outside this worktree'], [['mv', 'a.txt', join(outside, 'a.txt')], 'is outside this worktree'],
      [['rm', 'link/a.txt'], 'is outside this worktree'], [['revert', '--targets', 'escape.txt'], 'is outside this worktree'],
      [['rm', '--force', 'a.txt'], 'option --force is not allowed'], [['rm', '-m', 'x', 'a.txt'], 'option -m is not allowed'],
      [['cp', '^/trunk/a.txt', 'a.txt'], 'is a repository URL'], [['cp', 'https://svn.example/repo/a.txt', 'a.txt'], 'is a repository URL'],
      [['add', '--no-ignore', 'a.txt'], 'option --no-ignore is not allowed'], [['rm', '--targets', 'missing.txt'], 'its paths cannot be checked'],
      [['commit', '-m', 'x'], 'jamat-v3 commit propose --self'], [['up'], 'jamat-v3 sessions sync --self'],
    ] as const) {
      const result = run(args)
      expect(result.status, args.join(' ')).toBe(3)
      expect(result.stderr).toContain(`svn ${args[0]} is refused in a Jamat worktree: `)
      expect(result.stderr).toContain(reason)
    }
    const unconfined = run(['rm', 'a.txt'], { JAMAT_V3_SVN_SHIM_WORKTREE: '' })
    expect(unconfined.status).toBe(3)
    expect(unconfined.stderr).toContain('names no worktree')
  })
})
