import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SvnCommand } from '../../svn/svnCommand'

export class SvnShim {
  /**
   * `add` only schedules a path for the Finish review, which would add an unversioned path anyway; a
   * new property carrier must be versioned before a mapping tool can set `svn:externals` on it.
   * `--no-ignore` stays refused: it would schedule ignored trees such as `node_modules`.
   */
  static readonly localWritesConst = ['add']

  static ensure(localStateDir: string): string {
    const directory = join(localStateDir, 'svn-shim')
    mkdirSync(directory, { recursive: true })
    const program = `const { spawnSync } = require('node:child_process');
const commands = { ${SvnCommand.of.toString()} };
const args = process.argv.slice(2);
const command = commands.of(args);
const reads = new Set(${JSON.stringify([...SvnCommand.reads])});
const localWrites = new Set(${JSON.stringify(SvnShim.localWritesConst)});
if (!reads.has(command) && !(localWrites.has(command) && !args.includes('--no-ignore'))) {
  process.stderr.write('svn ' + (command ?? '(unknown command)') + ' is refused in a Jamat worktree. Use: jamat-v3 sessions sync --self, or ask the person to press Finish.\\n');
  process.exit(3);
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
