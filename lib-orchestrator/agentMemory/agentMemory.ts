import { randomUUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, normalize, relative, sep } from 'node:path'

import { ProviderTranscriptView } from '../projectManager/providerTranscriptView'
import { AntigravityConfigHome } from '../shared/antigravityConfigHome'
import { ErrnoCode } from '../shared/errnoCode'
import { ErrorText } from '../shared/errorText'
import type {
  AgentMemoryFile,
  AgentMemoryAgentId,
  AgentMemoryListing,
  AgentMemoryLocation,
  AgentMemoryResult,
  AgentMemoryText,
} from './agentMemoryApi.types'
import { ClaudeMemoryWrites } from './claudeMemoryWrites'

export interface AgentMemoryOptions {
  /** The main Claude config home; account profiles share its `projects` folder. */
  claudeHome: string
  /** The main Codex home; account profiles share its `memories` folder. */
  codexHome: string
  /** The global Antigravity config folder (`~/.gemini/config`). */
  antigravityConfigHome?: string
}

/**
 * The memory an agent keeps between conversations, as files a person reads, edits and deletes:
 * Claude's `<home>/projects/<project>/memory/`, one folder per project, and Codex's
 * `<home>/memories/`, one folder for every project. The user scope is the agent's user-level files
 * in its home, and only those named in `userEntriesConst`: the rest of a home is the agent's state.
 *
 * Every path is a name relative to that folder, checked before use, so no request reaches a file
 * outside it. A write replaces a file only when it is still the version that was read.
 */
export class AgentMemory {
  static readonly textBytesMaxConst = 1_048_576
  private static readonly filesMaxConst = 500
  private static readonly depthMaxConst = 4
  private static readonly indexNameConst = 'MEMORY.md'
  private static readonly conversationIdPatternConst = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  private static readonly nameCharactersPatternConst = /^[^\\:*?"<>|\x00-\x1f]{1,255}$/
  private static readonly userEntriesConst: Record<AgentMemoryAgentId, readonly { name: string; folder: boolean }[]> = {
    claude: [{ name: 'CLAUDE.md', folder: false }, { name: 'rules', folder: true }],
    codex: [{ name: 'AGENTS.md', folder: false }, { name: 'AGENTS.override.md', folder: false }, { name: 'memories', folder: true }],
    antigravity: [{ name: 'GEMINI.md', folder: false }, { name: 'AGENTS.md', folder: false }, { name: 'rules', folder: true }],
  }

  private readonly claudeHome: string
  private readonly codexHome: string
  private readonly antigravityConfigHome: string

  constructor(options: AgentMemoryOptions) {
    this.claudeHome = options.claudeHome
    this.codexHome = options.codexHome
    this.antigravityConfigHome = AntigravityConfigHome.globalConfigDirectory(options.antigravityConfigHome)
  }

  async directoryOf(query: AgentMemoryLocation): Promise<{ directory: string; scope: AgentMemoryListing['scope'] }> {
    if (query.scope === 'user')
      return {
        directory: AgentMemory.homeOf(query.agentId, this.claudeHome, this.codexHome, this.antigravityConfigHome),
        scope: 'user',
      }
    if (query.agentId === 'claude') {
      const projects = join(this.claudeHome, 'projects')
      const wanted = ProviderTranscriptView.claudeProjectFolderOf(query.projectPath)
      // The folder keeps the case the path was first typed in, so it is found case-blind.
      const found = (await AgentMemory.entries(projects))
        .find((entry) => entry.isDirectory() && entry.name.toLowerCase() === wanted.toLowerCase())
      return { directory: join(projects, found?.name ?? wanted, 'memory'), scope: 'project' }
    }
    else if (query.agentId === 'codex') return { directory: join(this.codexHome, 'memories'), scope: 'global' }
    else if (query.agentId === 'antigravity') return { directory: join(query.projectPath, '.agents', 'rules'), scope: 'project' }
    else throw new Error(`Unknown memory agent: ${JSON.stringify(query.agentId satisfies never)}`)
  }

  async list(query: AgentMemoryLocation): Promise<AgentMemoryResult<AgentMemoryListing>> {
    try {
      const { directory, scope } = await this.directoryOf(query)
      const found: { name: string; size: number; modifiedAt: number }[] = []
      const truncated = query.scope === 'user'
        ? await AgentMemory.walkUser(directory, AgentMemory.userEntriesConst[query.agentId], found)
        : await AgentMemory.walk(directory, '', 0, found)
      const written = new Set((await this.writtenBy(query)).map((path) => AgentMemory.key(path)))
      const files: AgentMemoryFile[] = found.map((file) => ({
        ...file, writtenByConversation: written.has(AgentMemory.key(join(directory, ...file.name.split('/')))),
      })).sort((a, b) => Number(b.name === AgentMemory.indexNameConst) - Number(a.name === AgentMemory.indexNameConst)
        || a.name.localeCompare(b.name))
      return { ok: true, value: { agentId: query.agentId, directory, scope, files, truncated } }
    }
    catch (error) { return { ok: false, code: 'failed', detail: ErrorText.of(error) } }
  }

  async read(query: AgentMemoryLocation, name: string): Promise<AgentMemoryResult<AgentMemoryText>> {
    const located = await this.fileOf(query, name)
    if (!located.ok) return located
    try {
      const stats = await stat(located.value)
      if (!stats.isFile()) return { ok: false, code: 'not-found', detail: `${name} is not a file` }
      if (stats.size > AgentMemory.textBytesMaxConst)
        return { ok: false, code: 'too-large', detail: `${name} is larger than ${AgentMemory.textBytesMaxConst} bytes` }
      return { ok: true, value: { name, text: await readFile(located.value, 'utf8'), modifiedAt: stats.mtimeMs } }
    }
    catch (error) { return AgentMemory.failureOf(name, error) }
  }

  /** Replaces an existing file, and only the version that was read: `expectedModifiedAt` is its time then. */
  async write(query: AgentMemoryLocation, name: string, text: string, expectedModifiedAt: number): Promise<AgentMemoryResult<{ modifiedAt: number }>> {
    if (Buffer.byteLength(text, 'utf8') > AgentMemory.textBytesMaxConst)
      return { ok: false, code: 'too-large', detail: `The text is larger than ${AgentMemory.textBytesMaxConst} bytes` }
    const located = await this.fileOf(query, name)
    if (!located.ok) return located
    try {
      // Written through a link to its target: a user-level file is often linked from a shared copy.
      const file = await realpath(located.value)
      const before = await stat(file)
      if (before.mtimeMs !== expectedModifiedAt)
        return { ok: false, code: 'conflict', detail: `${name} changed on disk after it was opened; reload it first` }
      const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, text, { encoding: 'utf8', mode: before.mode & 0o777 })
        await rename(temporary, file)
      }
      finally { await rm(temporary, { force: true }) }
      return { ok: true, value: { modifiedAt: (await stat(file)).mtimeMs } }
    }
    catch (error) { return AgentMemory.failureOf(name, error) }
  }

  /**
   * Deletes a file. Claude's `MEMORY.md` is the index Claude reads first, so its lines that link to
   * the deleted file go too; the answer counts them.
   */
  async remove(query: AgentMemoryLocation, name: string): Promise<AgentMemoryResult<{ indexLinesRemoved: number }>> {
    const located = await this.fileOf(query, name)
    if (!located.ok) return located
    try {
      if (!(await stat(located.value)).isFile()) return { ok: false, code: 'not-found', detail: `${name} is not a file` }
      await rm(located.value)
      if (query.scope === 'user' || query.agentId !== 'claude' || name === AgentMemory.indexNameConst)
        return { ok: true, value: { indexLinesRemoved: 0 } }
      return { ok: true, value: { indexLinesRemoved: await this.unlink(query, name) } }
    }
    catch (error) { return AgentMemory.failureOf(name, error) }
  }

  private async unlink(query: AgentMemoryLocation, name: string): Promise<number> {
    const index = join((await this.directoryOf(query)).directory, AgentMemory.indexNameConst)
    let text: string
    try { text = await readFile(index, 'utf8') }
    catch (error) {
      if (ErrnoCode.of(error) === 'ENOENT') return 0
      throw error
    }
    const lines = text.split('\n')
    const kept = lines.filter((line) => !line.includes(`](${name})`) && !line.includes(`](./${name})`))
    if (kept.length === lines.length) return 0
    const temporary = `${index}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, kept.join('\n'), 'utf8')
      await rename(temporary, index)
    }
    finally { await rm(temporary, { force: true }) }
    return lines.length - kept.length
  }

  private async writtenBy(query: AgentMemoryLocation): Promise<string[]> {
    if (query.scope === 'user') return []
    const id = query.nativeSessionId
    if (query.agentId !== 'claude' || id === undefined || !AgentMemory.conversationIdPatternConst.test(id)) return []
    return ClaudeMemoryWrites.of([this.claudeHome], [id])
  }

  private async fileOf(query: AgentMemoryLocation, name: string): Promise<AgentMemoryResult<string>> {
    const segments = name.split('/')
    if (!AgentMemory.nameCharactersPatternConst.test(name) || name.startsWith('/')
      || segments.some((segment) => segment === '' || segment === '.' || segment === '..')
      || (query.scope === 'user' && !AgentMemory.userEntriesConst[query.agentId]
        .some((entry) => entry.name.toLowerCase() === segments[0].toLowerCase() && entry.folder === segments.length > 1)))
      return { ok: false, code: 'invalid', detail: `Not a memory file name: ${JSON.stringify(name)}` }
    const { directory } = await this.directoryOf(query)
    const file = join(directory, ...segments)
    const inside = relative(directory, file)
    if (inside === '' || inside.startsWith('..') || inside.split(sep).includes('..'))
      return { ok: false, code: 'invalid', detail: `Not a memory file name: ${JSON.stringify(name)}` }
    return { ok: true, value: file }
  }

  private static homeOf(
    agentId: AgentMemoryAgentId,
    claudeHome: string,
    codexHome: string,
    antigravityConfigHome: string,
  ): string {
    if (agentId === 'claude') return claudeHome
    else if (agentId === 'codex') return codexHome
    else if (agentId === 'antigravity') return antigravityConfigHome
    else throw new Error(`Unknown memory agent: ${JSON.stringify(agentId satisfies never)}`)
  }

  /** The named user-level files and folders of a home, each one that exists. */
  private static async walkUser(
    home: string,
    entries: readonly { name: string; folder: boolean }[],
    found: { name: string; size: number; modifiedAt: number }[],
  ): Promise<boolean> {
    for (const entry of entries) {
      const path = join(home, entry.name)
      let stats
      try { stats = await stat(path) }
      catch { continue }
      if (entry.folder) {
        if (stats.isDirectory() && await AgentMemory.walk(path, entry.name, 1, found)) return true
      }
      else if (stats.isFile()) found.push({ name: entry.name, size: stats.size, modifiedAt: stats.mtimeMs })
    }
    return false
  }

  /** True when the listing stopped at its limit. */
  private static async walk(
    directory: string,
    prefix: string,
    depth: number,
    found: { name: string; size: number; modifiedAt: number }[],
  ): Promise<boolean> {
    for (const entry of await AgentMemory.entries(directory)) {
      const name = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (depth + 1 < AgentMemory.depthMaxConst && await AgentMemory.walk(path, name, depth + 1, found)) return true
      }
      else if (entry.isFile() && !entry.name.endsWith('.tmp')) {
        if (found.length >= AgentMemory.filesMaxConst) return true
        try {
          const stats = await stat(path)
          found.push({ name, size: stats.size, modifiedAt: stats.mtimeMs })
        }
        catch { /* gone between the listing and the stat */ }
      }
    }
    return false
  }

  private static async entries(directory: string): Promise<Dirent[]> {
    try { return await readdir(directory, { withFileTypes: true }) }
    catch { return [] }
  }

  private static key(path: string): string {
    return normalize(path).toLowerCase()
  }

  private static failureOf(name: string, error: unknown): AgentMemoryResult<never> {
    if (ErrnoCode.of(error) === 'ENOENT') return { ok: false, code: 'not-found', detail: `${name} does not exist` }
    return { ok: false, code: 'failed', detail: `${name}: ${ErrorText.of(error)}` }
  }
}
