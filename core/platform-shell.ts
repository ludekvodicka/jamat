/**
 * Cross-platform spawn helpers shared by the launcher (core) and the Electron main process.
 * Pure, no electron, node builtins only — so every process resolves the same way.
 *
 * On Windows the output is byte-identical to the previous hard-wired `cmd.exe /c …` calls
 * (regression safety); on POSIX it targets a login shell / direct exec instead.
 */

/** Wrap a whole shell command STRING (may carry `||`, pipes, etc.). Win: `cmd.exe /c <cmd>`.
 *  POSIX: a login shell (`-l -c`) so a GUI-launched Electron — which inherits a bare PATH on
 *  macOS — still picks up nvm/brew; falls back to `/bin/sh`. */
export function shellWrap(command: string): { file: string; args: string[] } {
  if (process.platform === 'win32') return { file: 'cmd.exe', args: ['/c', command] }
  return { file: process.env['SHELL'] || '/bin/sh', args: ['-l', '-c', command] }
}

/** Wrap an ARGV spawn (a binary + its args). Win: route through `cmd.exe /c` so PATH shims
 *  (`.cmd`/`.bat`) resolve; POSIX: exec the binary directly. */
export function shellWrapArgv(file: string, args: string[]): { file: string; args: string[] } {
  if (process.platform === 'win32') return { file: 'cmd.exe', args: ['/c', file, ...args] }
  return { file, args }
}

/** The default interactive shell for plain terminal tabs. Win: PowerShell; POSIX: `$SHELL`,
 *  else zsh on macOS / bash on Linux. */
export function defaultShell(): string {
  if (process.platform === 'win32') return 'powershell.exe'
  return process.env['SHELL'] || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
}
