import { readFileSync } from 'node:fs'

import { AppClientCliError } from './appClientCliError'

export class CliJsonFile {
  static read(file: string): unknown {
    try { return JSON.parse(readFileSync(file, 'utf8')) }
    catch (error) {
      throw new AppClientCliError(
        'invalid-request',
        `Cannot read JSON from ${JSON.stringify(file)}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}
