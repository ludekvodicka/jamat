import { dirname } from 'node:path'
import { ClaudeProjectsLocator } from './providers/claude/claudeProjectsLocator'
import { PathCompare } from '../shared/pathCompare'

export class ClaudeUsageDirectories {
  private readonly locator: ClaudeProjectsLocator
  private readonly directories = new Map<string, string | null>()

  constructor(home: string) { this.locator = new ClaudeProjectsLocator(home) }

  async prepare(cwds: readonly string[]): Promise<void> {
    for (const cwd of cwds) {
      const directory = await this.locator.resolveProjectDir(cwd)
      if (!directory) continue
      const key = PathCompare.comparable(directory), previous = this.directories.get(key)
      this.directories.set(key, previous === undefined || previous === cwd ? cwd : null)
    }
  }

  fallbackCwd(file: string): string { return this.directories.get(PathCompare.comparable(dirname(file))) ?? '' }
}
