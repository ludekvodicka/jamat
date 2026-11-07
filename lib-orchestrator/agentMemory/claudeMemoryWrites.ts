import { createReadStream, type Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import { JsonShape } from '../shared/jsonShape'

/**
 * The Claude auto-memory files a conversation wrote, read from its transcript and its sub-agents'
 * transcripts: the `file_path` of each `Write`, `Edit`, `MultiEdit` and `NotebookEdit` call that lies
 * in a `projects/<project>/memory/` folder. Every project folder of every home is searched, because
 * the id is unique and a moved project keeps its transcript under the old name.
 */
export class ClaudeMemoryWrites {
  private static readonly writingToolsConst: readonly string[] = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']
  private static readonly memoryPathPatternConst = /[\\/]projects[\\/][^\\/]+[\\/]memory[\\/]/i

  /** Paths as the transcript wrote them, without duplicates and sorted. */
  static async of(homes: readonly string[], ids: readonly string[]): Promise<string[]> {
    const written = new Set<string>()
    for (const file of await ClaudeMemoryWrites.transcriptsOf(homes, ids))
      for (const path of await ClaudeMemoryWrites.writtenPaths(file))
        if (ClaudeMemoryWrites.memoryPathPatternConst.test(path)) written.add(path)
    return [...written].sort()
  }

  private static async transcriptsOf(homes: readonly string[], ids: readonly string[]): Promise<string[]> {
    const files: string[] = []
    for (const home of homes)
      for (const project of await ClaudeMemoryWrites.entries(join(home, 'projects'))) {
        if (!project.isDirectory()) continue
        const projectDirectory = join(home, 'projects', project.name)
        for (const id of ids) {
          files.push(join(projectDirectory, `${id}.jsonl`))
          files.push(...await ClaudeMemoryWrites.jsonlBelow(join(projectDirectory, id, 'subagents')))
        }
      }
    return files
  }

  private static async entries(directory: string): Promise<Dirent[]> {
    try { return await readdir(directory, { withFileTypes: true }) }
    catch { return [] }
  }

  private static async jsonlBelow(directory: string): Promise<string[]> {
    const files: string[] = []
    for (const entry of await ClaudeMemoryWrites.entries(directory)) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) files.push(...await ClaudeMemoryWrites.jsonlBelow(path))
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path)
    }
    return files
  }

  /** A missing or unreadable transcript names no file. */
  private static async writtenPaths(file: string): Promise<string[]> {
    const paths: string[] = []
    const stream = createReadStream(file, { encoding: 'utf8' })
    try {
      for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
        if (!line.includes('"tool_use"') || !line.includes('memory')) continue
        let parsed: unknown
        try { parsed = JSON.parse(line) }
        catch { continue }
        const content = JsonShape.record(JsonShape.record(parsed)?.message)?.content
        if (!Array.isArray(content)) continue
        for (const block of content) {
          const call = JsonShape.record(block)
          if (call?.type !== 'tool_use' || typeof call.name !== 'string'
            || !ClaudeMemoryWrites.writingToolsConst.includes(call.name)) continue
          const path = JsonShape.record(call.input)?.file_path
          if (typeof path === 'string') paths.push(path)
        }
      }
    }
    catch { /* nothing to name */ }
    finally { stream.destroy() }
    return paths
  }
}
