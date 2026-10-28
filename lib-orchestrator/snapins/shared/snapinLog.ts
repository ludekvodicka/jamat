import { appendFile, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'

import { ErrnoCode } from '../../shared/errnoCode'
import { ErrorText } from '../../shared/errorText'
import { JsonlRecords } from '../../shared/jsonlRecords'

const entry = z.object({ at: z.number().finite(), level: z.enum(['info', 'warn', 'error']), text: z.string() })
export type SnapinLogEntry = z.infer<typeof entry>

export class SnapinLog {
  private readonly directory: string
  private readonly file: string
  private readonly report: (message: string) => void
  private writes: Promise<void>
  private reported: boolean

  constructor(directory: string, report: (message: string) => void) {
    this.directory = directory
    this.file = join(directory, 'log.jsonl')
    this.report = report
    this.writes = Promise.resolve()
    this.reported = false
  }

  append(value: SnapinLogEntry): Promise<void> {
    const next = this.writes.then(async () => {
      await mkdir(this.directory, { recursive: true })
      await appendFile(this.file, `${JSON.stringify(entry.parse(value))}\n`, { mode: 0o600 })
      if ((await stat(this.file)).size <= 1_048_576) return
      const recent = await this.read(2000)
      const temporary = `${this.file}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, recent.map((line) => JSON.stringify(line)).join('\n') + '\n', { mode: 0o600 })
        await rename(temporary, this.file)
      } finally {
        await unlink(temporary).catch(() => undefined)
      }
    }).catch((error: unknown) => this.failed(error))
    this.writes = next
    return next
  }

  async read(limit = 200): Promise<SnapinLogEntry[]> {
    try {
      return JsonlRecords.of(await readFile(this.file, 'utf8')).flatMap((value) => {
        const parsed = entry.safeParse(value)
        return parsed.success ? [parsed.data] : []
      }).slice(-limit)
    } catch (error) {
      if (ErrnoCode.of(error) !== 'ENOENT') this.failed(error)
      return []
    }
  }

  private failed(error: unknown): void {
    if (this.reported) return
    this.reported = true
    this.report(`Snap-in log ${this.file} is unavailable: ${ErrorText.of(error)}`)
  }
}
