import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SvnCommand } from '../../svn/svnCommand'

/** The options one local write accepts: `flags` stand alone, `values` take the next argument. */
interface SvnShimWritePolicy {
  flags: readonly string[]
  values: readonly string[]
}

/** What the confinement check needs from its process; the generated program hands in node's own. */
export interface SvnShimPaths {
  /** The worker's worktree, from `JAMAT_V3_SVN_SHIM_WORKTREE`. */
  worktree: string | undefined
  /** Resolved against the cwd svn would use. */
  resolve(path: string): string
  /** The nearest existing ancestor with its links and junctions resolved, the rest appended. */
  real(path: string): string
  relative(from: string, to: string): string
  isAbsolute(path: string): boolean
  readTargets(path: string): string
}

export class SvnShim {
  static readonly worktreeVariableConst = 'JAMAT_V3_SVN_SHIM_WORKTREE'
  private static readonly quietConst = ['-q', '--quiet', '--non-interactive', '--no-auth-cache']
  private static readonly deleteConst: SvnShimWritePolicy = { flags: [...SvnShim.quietConst, '--keep-local'], values: ['--targets'] }
  private static readonly moveConst: SvnShimWritePolicy = { flags: [...SvnShim.quietConst, '--parents', '--allow-mixed-revisions'], values: [] }
  private static readonly copyConst: SvnShimWritePolicy = { flags: [...SvnShim.quietConst, '--parents', '--ignore-externals'], values: ['-r', '--revision'] }

  /**
   * The local writes a worker may run, by every svn alias, each confined to its own worktree by
   * `refusalOf`. An option outside a command's list is refused, so none is ever read as a path.
   * - `add` schedules a path for the Finish review, which would add an unversioned path anyway; a
   *   new property carrier must be versioned before a mapping tool can set `svn:externals` on it.
   *   `--no-ignore` stays refused: it would schedule ignored trees such as `node_modules`.
   * - `delete` and `move` keep a removal and a rename with their history; refused, a rename reached
   *   the review as a delete plus an add without copy-from (r290). `delete --force` stays refused:
   *   it also throws away unversioned and modified files.
   * - `copy` is a local add with history. `revert` undoes the worker's own local changes.
   * - `move --allow-mixed-revisions`: a synced worktree is mixed-revision, and the worker cannot
   *   update it to one revision itself.
   */
  static readonly localWritesConst: Readonly<Record<string, SvnShimWritePolicy>> = {
    add: { flags: [...SvnShim.quietConst, '--force', '--parents', '--auto-props', '--no-auto-props', '-N', '--non-recursive'], values: ['--depth', '--targets'] },
    delete: SvnShim.deleteConst, del: SvnShim.deleteConst, remove: SvnShim.deleteConst, rm: SvnShim.deleteConst,
    move: SvnShim.moveConst, mv: SvnShim.moveConst, rename: SvnShim.moveConst, ren: SvnShim.moveConst,
    copy: SvnShim.copyConst, cp: SvnShim.copyConst,
    revert: { flags: [...SvnShim.quietConst, '-R', '--recursive', '--remove-added'], values: ['--depth', '--targets', '--changelist', '--cl'] },
  }

  private static readonly allowedConst = 'A worker runs svn reads, and add, delete, move, copy and revert of paths inside its own worktree'
  /** What works instead of a refused command; any command not named here gets `allowedConst` alone. */
  private static readonly adviceConst: Readonly<Record<string, string>> = Object.fromEntries([
    ...['commit', 'ci'].map((command) => [command, 'Work leaves a worktree only through Finish: '
      + 'jamat-v3 commit propose --self --message-file FILE gives its message, then tell the person the work is ready']),
    ...['update', 'up', 'switch', 'sw'].map((command) => [command, 'Take repository changes with jamat-v3 sessions sync --self']),
    ...['resolve', 'resolved'].map((command) => [command, 'Settle conflicts with jamat-v3 sessions conflicts --self '
      + 'and jamat-v3 sessions resolve-conflict --self']),
  ])

  /**
   * Why a local write may not run, or null when every path it names, `--targets` lines included, is
   * inside the worktree. The generated program runs it from its source text, so it reads nothing
   * but its parameters.
   */
  static refusalOf(command: string, args: readonly string[], policy: SvnShimWritePolicy, paths: SvnShimPaths): string | null {
    if (!paths.worktree) return 'this launch names no worktree to confine it to'
    const named: string[] = []
    let commandSeen = false
    let positionalOnly = false
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]
      if (positionalOnly || !arg.startsWith('-')) {
        if (commandSeen) named.push(arg)
        else commandSeen = true
        continue
      }
      if (arg === '--') {
        positionalOnly = true
        continue
      }
      const equals = arg.indexOf('=')
      const name = arg.startsWith('--') ? equals > 0 ? arg.slice(0, equals) : arg : arg.slice(0, 2)
      if (name === arg && policy.flags.includes(name)) continue
      if (!policy.values.includes(name)) return `option ${arg} is not allowed for svn ${command}`
      const value = name === arg ? args[++index] : arg.slice(name.length + (arg.startsWith('--') ? 1 : 0))
      if (value === undefined || value === '') return `option ${name} needs a value`
      if (name === '--targets')
        for (const line of paths.readTargets(paths.resolve(value)).split(/\r?\n/))
          if (line.trim() !== '') named.push(line.trim())
    }
    const root = paths.real(paths.resolve(paths.worktree))
    for (const target of named) {
      if (/^[a-z][a-z0-9+.-]+:\/\//i.test(target) || target.startsWith('^/'))
        return `${target} is a repository URL; a worker writes only paths of its own worktree`
      // svn reads the text after the last `@` as a peg revision; both readings must stay inside.
      const at = target.lastIndexOf('@')
      for (const candidate of at > 0 ? [target, target.slice(0, at)] : [target]) {
        const relative = paths.relative(root, paths.real(paths.resolve(candidate)))
        if (/^\.\.([\\/]|$)/.test(relative) || paths.isAbsolute(relative))
          return `${target} is outside this worktree (${paths.worktree})`
      }
    }
    return null
  }

  static ensure(localStateDir: string): string {
    const directory = join(localStateDir, 'svn-shim')
    mkdirSync(directory, { recursive: true })
    const program = `const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const commands = { ${SvnCommand.of.toString()}, ${SvnShim.refusalOf.toString()} };
const args = process.argv.slice(2);
const command = commands.of(args);
const reads = new Set(${JSON.stringify([...SvnCommand.reads])});
const writes = ${JSON.stringify(SvnShim.localWritesConst)};
const advice = ${JSON.stringify(SvnShim.adviceConst)};
function realOf(target) {
  const tail = [];
  for (let current = target; ; current = path.dirname(current)) {
    try { return path.join(fs.realpathSync.native(current), ...tail); } catch {}
    if (path.dirname(current) === current) return target;
    tail.unshift(path.basename(current));
  }
}
if (command === null || !reads.has(command)) {
  let refusal = null;
  if (command !== null && Object.hasOwn(writes, command)) {
    try {
      refusal = commands.refusalOf(command, args, writes[command], { worktree: process.env.${SvnShim.worktreeVariableConst},
        resolve: (target) => path.resolve(target), real: realOf, relative: path.relative, isAbsolute: path.isAbsolute,
        readTargets: (target) => fs.readFileSync(target, 'utf8') });
    } catch (error) { refusal = 'its paths cannot be checked: ' + (error && error.message); }
  } else refusal = command !== null && Object.hasOwn(advice, command) ? advice[command] : 'it is not a local write of this worktree';
  if (refusal !== null) {
    process.stderr.write('svn ' + (command ?? '(unknown command)') + ' is refused in a Jamat worktree: ' + refusal + '. '
      + ${JSON.stringify(SvnShim.allowedConst)} + '; ask the person for anything else.\\n');
    process.exit(3);
  }
}
const result = spawnSync(process.env.JAMAT_V3_REAL_SVN, args, { stdio: 'inherit', windowsHide: true });
if (result.error) process.stderr.write(result.error.message + '\\n');
process.exit(result.status ?? 1);
`
    writeFileSync(join(directory, 'svn-shim.cjs'), program, 'utf8')
    writeFileSync(join(directory, 'svn.cmd'), '@echo off\r\nsetlocal\r\nset ELECTRON_RUN_AS_NODE=1\r\n"%JAMAT_V3_SVN_SHIM_NODE%" "%~dp0svn-shim.cjs" %*\r\nexit /b %ERRORLEVEL%\r\n', 'utf8')
    writeFileSync(join(directory, 'svn'), '#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "$JAMAT_V3_SVN_SHIM_NODE" "$(dirname "$0")/svn-shim.cjs" "$@"\n', { encoding: 'utf8', mode: 0o755 })
    return directory
  }
}
