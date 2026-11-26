import { randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { rename, unlink, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

export class AtomicJsonFile {
  private static readonly ownerOnlyDirectoryConst = 0o700
  private static readonly ownerOnlyFileConst = 0o600
  private static readonly windowsHeldCodesConst: ReadonlySet<string> = new Set(['EPERM', 'EACCES', 'EBUSY'])
  private static readonly windowsRetryPausesMsConst: readonly number[] = [20, 40, 80, 160, 320]

  static ensureDirectory(directory: string): void {
    mkdirSync(directory, {
      recursive: true,
      mode: AtomicJsonFile.ownerOnlyDirectoryConst,
    })
  }

  static write(file: string, value: unknown): void {
    const temporaryFile = `${file}.tmp`
    try { unlinkSync(temporaryFile) } catch { /* absent */ }
    writeFileSync(temporaryFile, JSON.stringify(value, null, 2), {
      encoding: 'utf-8',
      mode: AtomicJsonFile.ownerOnlyFileConst,
    })
    renameSync(temporaryFile, file)
  }

  static async writeAsync(file: string, value: unknown): Promise<void> {
    const temporaryFile = `${file}.${process.pid}.${randomUUID()}.tmp`
    let committed = false
    try {
      await writeFile(temporaryFile, JSON.stringify(value, null, 2), {
        encoding: 'utf-8',
        mode: AtomicJsonFile.ownerOnlyFileConst,
      })
      await AtomicJsonFile.renameRetried(temporaryFile, file)
      committed = true
    } finally {
      if (!committed)
        try { await unlink(temporaryFile) } catch { /* absent or already moved */ }
    }
  }

  static ownerOnlyFileMode(): number {
    return AtomicJsonFile.ownerOnlyFileConst
  }

  private static async renameRetried(from: string, to: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(from, to)
        return
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
          ? error.code : null
        if (process.platform !== 'win32'
          || code === null
          || !AtomicJsonFile.windowsHeldCodesConst.has(code)
          || attempt >= AtomicJsonFile.windowsRetryPausesMsConst.length)
          throw error
        await delay(AtomicJsonFile.windowsRetryPausesMsConst[attempt])
      }
    }
  }
}
