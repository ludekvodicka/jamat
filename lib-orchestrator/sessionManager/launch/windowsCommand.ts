import { existsSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'

/**
 * Which program a bare command name actually starts on Windows, answered the way cmd.exe answers it:
 * every directory of `PATH` in order, and inside each one every extension of `PATHEXT` in order,
 * with the first file that exists winning.
 *
 * It asks two narrow questions about that one file, and both exist because a `.cmd` shim cuts a
 * command line at its first newline exactly as the `cmd /d /q /c` wrap does - the shim IS cmd.exe.
 * **Is what runs an executable image**, which a spawn can start with no cmd.exe in front of it, and,
 * when it is not, **did the same installer write a PowerShell script beside it**. npm and pnpm write
 * `<name>.ps1` next to every `<name>.cmd`, and that script calls `node.exe` itself, so nothing in
 * that chain is cmd.exe either. It is the installer's own file rather than a guess at the shim's
 * format, which is what keeps it apart from reading the shim and reconstructing the command.
 *
 * The session's working directory is deliberately NOT searched, although cmd.exe searches it first.
 * A program sitting in a checkout is not the agent this machine installed, and the caller reaches
 * for this to get cmd.exe out of the way, never to choose between two installations.
 */
export class WindowsCommand {
  private static readonly imageExtensionsConst = new Set(['.exe', '.com'])
  private static readonly powershellExtensionConst = '.ps1'
  /** What Windows falls back to when `PATHEXT` is unset, in its own order. */
  private static readonly defaultExtensionsConst = '.COM;.EXE;.BAT;.CMD'

  /** The executable image a bare name starts, or null for a shim as well as for nothing at all. */
  static imageOf(command: string, environment: NodeJS.ProcessEnv): string | null {
    const hit = WindowsCommand.hitOf(command, environment)
    return hit !== null && WindowsCommand.isImage(hit) ? hit : null
  }

  /**
   * The PowerShell script beside the shim this name starts, or null when the name starts an image,
   * starts nothing, or starts a shim standing on its own - a `.cmd` written by hand has no sibling
   * and there is nothing to guess.
   */
  static powershellScriptOf(command: string, environment: NodeJS.ProcessEnv): string | null {
    const hit = WindowsCommand.hitOf(command, environment)
    if (hit === null || WindowsCommand.isImage(hit)) return null
    const extension = extname(hit)
    const script = join(
      dirname(hit),
      `${basename(hit, extension)}${WindowsCommand.powershellExtensionConst}`,
    )
    return existsSync(script) ? script : null
  }

  private static hitOf(command: string, environment: NodeJS.ProcessEnv): string | null {
    const extensions = WindowsCommand.extensionsOf(environment)
    for (const directory of WindowsCommand.directoriesOf(environment))
      for (const extension of extensions) {
        // The first file that exists is the one that would run, so a shim found here ends the
        // search: an `.exe` in a later directory is a program cmd.exe would never have reached.
        const candidate = join(directory, `${command}${extension}`)
        if (existsSync(candidate)) return candidate
      }
    return null
  }

  private static isImage(path: string): boolean {
    return WindowsCommand.imageExtensionsConst.has(extname(path).toLowerCase())
  }

  /** A `PATH` entry may be quoted, and an empty one means the current directory, which is not ours. */
  private static directoriesOf(environment: NodeJS.ProcessEnv): string[] {
    return WindowsCommand.split(environment.PATH ?? environment.Path ?? '')
      .map((entry) => entry.replace(/^"(.*)"$/, '$1'))
      .filter((entry) => entry.length > 0)
  }

  /** Lower-cased because `PATHEXT` is conventionally shouted and a Windows extension has no case. */
  private static extensionsOf(environment: NodeJS.ProcessEnv): string[] {
    return WindowsCommand
      .split(environment.PATHEXT ?? WindowsCommand.defaultExtensionsConst)
      .filter((entry) => entry.startsWith('.'))
      .map((entry) => entry.toLowerCase())
  }

  private static split(value: string): string[] {
    return value.split(';').map((entry) => entry.trim())
  }
}
