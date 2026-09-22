import { randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'

/**
 * Canonical home of the helper both app-host and app-client-ui carried a copy of. The Host's version
 * used to differ by an ACL half that guarded its token; that mechanism was deleted on 2026-08-10.
 *
 * **Three differences are left, and a fix here reaches the Host only by hand**, since no import may
 * leave that package. This copy takes a file mode per call, which the Host has no use for; the
 * Host's copy instead pins `0o700` on the directory it creates and exposes `ownerOnlyFileMode()`,
 * which two of its files call. This copy also has the asynchronous pair below, which the client's
 * main process needs and the Host does not: the Host writes its descriptor once per boot, while the
 * client rewrites the session records from a timer that shares a loop with every keystroke. None of
 * the three is accidental, and this paragraph is the only thing keeping the two in step - so it is
 * the first thing to update when any of them changes.
 */
export class AtomicJsonFile {
  /** Machine state: nobody but this user has any business reading it. */
  private static readonly ownerOnlyFileConst = 0o600
  /** A file that lives in the user's own checkout and is meant to be committed and read by tools. */
  static readonly checkedInFileConst = 0o644

  static ensureDirectory(directory: string): void {
    mkdirSync(directory, { recursive: true })
  }

  /**
   * The mode is a parameter because this helper writes into two different worlds: everything under
   * the machine state root is owner-only, and a file inside the user's checkout has to keep the
   * permissions a checked-in file has - a 0600 `.worktree.json` would be re-tightened on every save.
   */
  static write(file: string, value: unknown, mode = AtomicJsonFile.ownerOnlyFileConst): void {
    const temporaryFile = `${file}.${process.pid}.${randomUUID()}.tmp`
    let committed = false
    try {
      writeFileSync(temporaryFile, JSON.stringify(value, null, 2), { encoding: 'utf-8', mode })
      renameSync(temporaryFile, file)
      committed = true
    } finally {
      if (!committed)
        try { unlinkSync(temporaryFile) } catch { /* absent or already moved */ }
    }
  }

  static async ensureDirectoryAsync(directory: string): Promise<void> {
    await mkdir(directory, { recursive: true })
  }

  /**
   * The same write, off the event loop.
   *
   * It exists for the one caller that writes on a timer rather than on a decision: the session
   * records are rewritten whole every two seconds for as long as somebody is typing, and the
   * `writeFileSync` plus `renameSync` of a growing document landed on the loop that carries every
   * keystroke to the Host and every frame back. On Windows, with a real-time scanner over the
   * machine-state root, that rename alone is tens to hundreds of milliseconds.
   *
   * The serialization is still synchronous, and deliberately: `JSON.stringify` of the document is
   * microseconds, and building it off-thread would need the document copied to a worker.
   */
  static async writeAsync(
    file: string,
    value: unknown,
    mode = AtomicJsonFile.ownerOnlyFileConst,
  ): Promise<void> {
    const temporaryFile = `${file}.${process.pid}.${randomUUID()}.tmp`
    let committed = false
    try {
      await writeFile(temporaryFile, JSON.stringify(value, null, 2), { encoding: 'utf-8', mode })
      await rename(temporaryFile, file)
      committed = true
    } finally {
      if (!committed)
        try { await unlink(temporaryFile) } catch { /* absent or already moved */ }
    }
  }
}
