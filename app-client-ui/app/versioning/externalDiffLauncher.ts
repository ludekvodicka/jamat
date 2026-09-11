import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { FileChangesManager, FileChangesFileAccessResult } from '../../../lib-orchestrator/fileChangesManager/fileChangesManager'
import type { FileDiffRequest } from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import { CommandInvoker } from '../../../lib-orchestrator/shared/commandInvoker'
import { ErrorText } from '../../../lib-orchestrator/shared/errorText'
import { VersioningSettings, type VersioningDiffTool } from '../../shared/versioningSettings'
import type { VersioningExternalDiffResult } from '../../shared/versioningCommit'

export class ExternalDiffLauncher {
  private readonly active = new Set<string>()
  private readonly commands: Pick<CommandInvoker, 'launchInteractive'>
  private readonly tmpRoot: string

  constructor(private readonly deps: {
    readBaseline: FileChangesManager['readBaseline']
    fileAccess(ownerId: string, snapshotId: string, fileId: string): FileChangesFileAccessResult
    toolOf(): VersioningDiffTool
    reportError(detail: string): void
    commands?: Pick<CommandInvoker, 'launchInteractive'>
    tmpRoot?: string
  }) {
    this.commands = deps.commands ?? new CommandInvoker()
    this.tmpRoot = deps.tmpRoot ?? tmpdir()
  }

  async launch(ownerId: string, request: FileDiffRequest): Promise<VersioningExternalDiffResult> {
    const access = this.deps.fileAccess(ownerId, request.snapshotId, request.fileId)
    if (!access.ok) return { ok: false, detail: access.detail }
    if (access.value.nodeKind === 'directory') return { ok: false, detail: 'A directory has no text diff' }
    const tool = this.deps.toolOf()
    if (!VersioningSettings.isDiffTool(tool)) return { ok: false, detail: 'The external diff tool is not configured correctly' }
    if (tool.kind === 'internal') return { ok: false, detail: 'No external diff viewer is configured' }
    else if (tool.kind !== 'external') throw new Error(`Unknown diff tool: ${JSON.stringify(tool)}`)
    const template = VersioningSettings.argumentsOf(tool.argumentTemplate)
    if (template === null) return { ok: false, detail: 'The external diff arguments contain unmatched quotes' }
    let directory: string | null = null
    try {
      const baseline = await this.deps.readBaseline(request)
      if (!baseline.ok) return { ok: false, detail: baseline.detail }
      if (baseline.kind === 'binary' || baseline.kind === 'unavailable') return { ok: false, detail: baseline.detail }
      await this.sweep()
      directory = await mkdtemp(join(this.tmpRoot, 'jamat-v3-diff-'))
      this.active.add(directory)
      await mkdir(join(directory, 'base'))
      const base = join(directory, 'base', basename(access.value.path))
      await writeFile(base, baseline.kind === 'content' ? baseline.content : '', 'utf8')
      const tokens: Record<string, string> = { '1': base, '2': access.value.path, base, mine: access.value.path, bname: baseline.label, yname: 'Working tree' }
      const args = template.map((argument) => argument.replace(/\$([12])(?!\d)|%(base|mine|bname|yname)\b/g,
        (_match, numbered: string | undefined, named: string) => tokens[numbered ?? named]!))
      const started = await this.commands.launchInteractive({ command: tool.command, args, cwd: access.value.cwd, env: process.env })
      if (!started.ok) return { ok: false, detail: `Cannot start ${tool.command}: ${started.detail}` }
      const ownedDirectory = directory
      directory = null
      void started.closed.then(() => this.remove(ownedDirectory)).catch((error) => this.deps.reportError(ErrorText.of(error)))
      return { ok: true }
    } catch (error) { return { ok: false, detail: ErrorText.of(error) } }
    finally { if (directory !== null) await this.remove(directory) }
  }

  private async remove(directory: string): Promise<void> {
    try { await rm(directory, { recursive: true, force: true }) }
    finally { this.active.delete(directory) }
  }

  private async sweep(): Promise<void> {
    for (const entry of await readdir(this.tmpRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^jamat-v3-diff-[A-Za-z0-9]+$/.test(entry.name)) continue
      const directory = join(this.tmpRoot, entry.name)
      if (this.active.has(directory)) continue
      try {
        if ((await stat(directory)).mtimeMs < Date.now() - 86_400_000) await this.remove(directory)
      } catch (error) { this.deps.reportError(ErrorText.of(error)) }
    }
  }
}
