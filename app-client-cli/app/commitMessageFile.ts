import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppClientCliError } from './appClientCliError'

export class CommitMessageFile {
  // The CLI cannot import the Electron package; the dialog's message cap is enforced here too.
  static readonly messageMaxCharactersConst = 16_384
  private static readonly maximumAgeMillisecondsConst = 86_400_000

  static validate(text: string): string {
    if (text.length > CommitMessageFile.messageMaxCharactersConst)
      throw new AppClientCliError('invalid-request', 'The commit message is limited to 16384 characters')
    return text
  }

  static read(path: string): string {
    if (statSync(path).size > CommitMessageFile.messageMaxCharactersConst * 4)
      throw new AppClientCliError('invalid-request', 'The commit message file is too large')
    return CommitMessageFile.validate(readFileSync(path, 'utf8'))
  }

  static async write(text: string, directory = join(tmpdir(), 'jamat-v3-commit-msgs')): Promise<string> {
    CommitMessageFile.validate(text)
    await mkdir(directory, { recursive: true })
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !/^[\da-f-]{36}\.txt$/i.test(entry.name)) continue
      const path = join(directory, entry.name)
      const info = await stat(path).catch(() => null)
      if (info !== null && Date.now() - info.mtimeMs > CommitMessageFile.maximumAgeMillisecondsConst) await unlink(path).catch(() => undefined)
    }
    const path = join(directory, `${randomUUID()}.txt`)
    await writeFile(path, text, { encoding: 'utf8', flag: 'wx' })
    return path
  }
}
