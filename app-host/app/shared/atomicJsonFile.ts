import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'

export class AtomicJsonFile {
  private static readonly ownerOnlyDirectoryConst = 0o700
  private static readonly ownerOnlyFileConst = 0o600

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

  static ownerOnlyFileMode(): number {
    return AtomicJsonFile.ownerOnlyFileConst
  }
}
