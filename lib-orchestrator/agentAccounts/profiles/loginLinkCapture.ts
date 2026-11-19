import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * A login CLI that opens its sign-in page through the program a variable names (Claude reads BROWSER)
 * runs this script instead: no browser opens, and the link waits in the profile until the person
 * copies it into the browser profile the account belongs to.
 */
export class LoginLinkCapture {
  static readonly directoryName = '.jamat-login-link'
  static readonly linkLimit = 16_384

  static async prepare(home: string, variable: string): Promise<Record<string, string>> {
    const directory = join(home, LoginLinkCapture.directoryName)
    await mkdir(directory, { recursive: true })
    await unlink(join(directory, 'link.txt')).catch(LoginLinkCapture.ignoreMissing)
    const windows = process.platform === 'win32'
    const script = join(directory, windows ? 'open-link.cmd' : 'open-link.sh')
    // %1 keeps the quotes the CLI puts around the URL; unquoted, cmd would split the URL at its first &.
    await writeFile(script, windows ? '@echo off\r\n>"%~dp0link.txt" echo %1\r\nexit /b 0\r\n'
      : '#!/bin/sh\nprintf \'%s\\n\' "$1" > "$(dirname "$0")/link.txt"\n', { mode: 0o700 })
    return { [variable]: script }
  }

  /** The captured https link, or null while none is there or the file holds anything else. */
  static async read(home: string): Promise<string | null> {
    let text: string
    try { text = await readFile(join(home, LoginLinkCapture.directoryName, 'link.txt'), 'utf8') }
    catch { return null }
    const link = text.trim().replace(/^"(.*)"$/, '$1')
    return link.length <= LoginLinkCapture.linkLimit && /^https:\/\/\S+$/.test(link) ? link : null
  }

  private static ignoreMissing(error: unknown): void {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
