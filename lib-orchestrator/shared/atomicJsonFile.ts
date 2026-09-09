import { randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'

/**
 * Canonical home of the helper both app-host and app-client-ui carried a copy of. The Host's version
 * used to differ by an ACL half that guarded its token; that mechanism was deleted on 2026-08-10.
 *
 * **Two differences are left, and a fix here reaches the Host only by hand**, since no import may
 * leave that package. This copy takes a file mode per call, which the Host has no use for; the
 * Host's copy instead pins `0o700` on the directory it creates and exposes `ownerOnlyFileMode()`,
 * which two of its files call. Neither difference is accidental, and this paragraph is the only
 * thing keeping the two in step - so it is the first thing to update when either one changes.
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
}
