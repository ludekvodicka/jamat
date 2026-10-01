import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export class AppContext {
  readonly logFile: string

  constructor(logFile: string) {
    this.logFile = logFile
    mkdirSync(dirname(logFile), { recursive: true })
  }

  log(message: string): void {
    appendFileSync(this.logFile, `${new Date().toISOString()} ${message}\n`, 'utf8')
  }
}
