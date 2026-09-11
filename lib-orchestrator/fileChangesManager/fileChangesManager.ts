import { randomUUID } from 'node:crypto'
import { lstat, readFile, stat } from 'node:fs/promises'
import { relative } from 'node:path'

import type { ProviderTranscriptRef } from '../projectManager/providerTranscriptView'
import { ProviderTranscriptView } from '../projectManager/providerTranscriptView'
import { ErrorText } from '../shared/errorText'
import { PathCompare } from '../shared/pathCompare'
import { FileDiffBuilder } from './diff/fileDiffBuilder'
import type { FileDiffExecutionContext, FileDiffExecutor } from './diff/fileDiffExecutor'
import type {
  FileChangeBaseline,
  FileChangeEntry,
  FileChangeGroup,
  FileChangesAgentId,
  FileChangesContext,
  FileChangesHistoryResult,
  FileChangesListOptions,
  FileChangesSnapshotResult,
  FileChangesWorkingTreeContext,
  FileChangesWorkingTreeSnapshotResult,
  FileChangesWorkingTreeSnapshot,
  FileChangesWorkingTreeSource,
  FileChangesVcsDetection,
  FileDiffRequest,
  FileDiffResult,
} from './fileChangesManagerApi.types'
import { FileHistoryComposer } from './history/fileHistoryComposer'
import { FileChangesListing, type FileChangesListingItem } from './listing/fileChangesListing'
import { FileChangesLogSourceClaude } from './logs/fileChangesLogSourceClaude'
import { FileChangesLogSourceCodex } from './logs/fileChangesLogSourceCodex'
import type { FileChangesLogGroup, FileChangesLogMutation } from './logs/fileChangesLogSource.types'
import {
  FileChangesSnapshotStore,
  type SnapshotBaseline,
  type SnapshotBaselineFile,
  type SnapshotFile,
} from './snapshots/fileChangesSnapshotStore'
import type {
  FileChangesVcs,
  FileChangesVcsBaselineRef,
  FileChangesVcsEntry,
  FileChangesVcsHistoryGroup,
} from './vcs/fileChangesVcs.types'
import { FileChangesVcsDetector } from './vcs/fileChangesVcsDetector'
import { FileChangesVcsGit } from './vcs/fileChangesVcsGit'
import { FileChangesVcsSvn } from './vcs/fileChangesVcsSvn'
import { FileChangesWorkingTreeSources } from './working/fileChangesWorkingTreeSources'
import { FileChangesSvnUntracked } from './working/fileChangesSvnUntracked'

export interface FileChangesTranscriptResolver {
  resolve(input: {
    agentId: FileChangesAgentId
    cwd: string
    nativeSessionId: string
  }): Promise<ProviderTranscriptRef | null>
}

export interface FileChangesLogReader {
  readonly agentId: FileChangesAgentId
  load(ref: ProviderTranscriptRef, cwd: string): Promise<readonly FileChangesLogGroup[]>
}

export interface FileChangesManagerDeps {
  diffExecutor: FileDiffExecutor
  vcsAdapters?: readonly FileChangesVcs[]
  transcriptResolver?: FileChangesTranscriptResolver
  logReaders?: readonly FileChangesLogReader[]
  snapshotStore?: FileChangesSnapshotStore
  workingSources?: FileChangesWorkingTreeSources
  svnUntracked?: Pick<FileChangesSvnUntracked, 'expand'>
}

export type FileChangesBaselineContentResult =
  | { ok: true; kind: 'content'; content: string; label: string }
  | { ok: true; kind: 'missing'; label: string }
  | { ok: true; kind: 'binary'; detail: string }
  | { ok: true; kind: 'unavailable'; detail: string }
  | Extract<FileDiffResult, { ok: false }>

export type FileChangesFileAccessResult =
  | {
    ok: true
    value: {
      sessionId: string
      cwd: string
      path: string
      nodeKind: FileChangeEntry['nodeKind']
      status: FileChangeEntry['status']
      workingState?: SnapshotFile['workingState']
    }
  }
  | { ok: false; code: 'snapshot-expired' | 'unknown-file'; detail: string }

interface FileRegistry {
  ids: Map<string, string>
  files: Map<string, SnapshotFile>
}

export class FileChangesManager {
  private static readonly defaultHistoryPageSizeConst = 20
  private static readonly maxHistoryPageSizeConst = 50
  private static readonly vcsHistoryLimitConst = 100
  private static readonly chatHistoryLimitConst = 100

  private readonly detector: FileChangesVcsDetector
  private readonly transcriptResolver: FileChangesTranscriptResolver
  private readonly logReaders: ReadonlyMap<FileChangesAgentId, FileChangesLogReader>
  private readonly snapshots: FileChangesSnapshotStore
  private readonly listing = new FileChangesListing()
  private readonly historyComposer = new FileHistoryComposer()
  private readonly diffBuilder: FileDiffBuilder
  private readonly workingSources: FileChangesWorkingTreeSources
  private readonly svnUntracked: Pick<FileChangesSvnUntracked, 'expand'>

  constructor(deps: FileChangesManagerDeps) {
    this.detector = new FileChangesVcsDetector(
      deps.vcsAdapters ?? [new FileChangesVcsGit(), new FileChangesVcsSvn()],
    )
    this.transcriptResolver = deps.transcriptResolver ?? new ProviderTranscriptView()
    const logReaders = deps.logReaders
      ?? [new FileChangesLogSourceClaude(), new FileChangesLogSourceCodex()]
    this.logReaders = new Map(logReaders.map((source) => [source.agentId, source]))
    this.snapshots = deps.snapshotStore ?? new FileChangesSnapshotStore()
    this.diffBuilder = new FileDiffBuilder(deps.diffExecutor)
    this.workingSources = deps.workingSources ?? new FileChangesWorkingTreeSources()
    this.svnUntracked = deps.svnUntracked ?? new FileChangesSvnUntracked()
  }

  async workingTree(
    context: FileChangesWorkingTreeContext,
    requested: FileChangesWorkingTreeSource | null,
    forCommit = false,
  ): Promise<FileChangesWorkingTreeSnapshotResult> {
    const invalid = await FileChangesManager.invalidContext(context)
    if (invalid !== null) return { ok: false, code: 'invalid-context', detail: invalid }
    const read = await this.workingSources.read(context, requested)
    let vcsEntries = read.entries
    if (forCommit && read.selection.selected === 'svn') {
      try { vcsEntries = await this.svnUntracked.expand(vcsEntries) }
      catch (error) { return { ok: false, code: 'invalid-context', detail: ErrorText.of(error) } }
    }
    const warnings = [...read.warnings]
    const items = await this.listing.build({
      cwd: context.cwd,
      hasVcs: read.selected !== null,
      vcsEntries,
      logGroups: [],
      warnings,
      includeDirectories: !forCommit,
    })
    const registry: FileRegistry = { ids: new Map(), files: new Map() }
    const entries = items.map((item) => this.publicEntry(item, item.absolutePath, registry))
    for (const item of items) {
      const file = registry.files.get(registry.ids.get(PathCompare.comparable(item.absolutePath))!)!
      // Folder labels show the newest descendant; committing needs the node's own timestamp.
      const stamp = await lstat(item.absolutePath).then((value) => Math.round(value.mtimeMs)).catch(() => null)
      file.workingState = { modifiedAt: stamp, vcsEntry: item.repositoryPath !== null }
    }
    const baselines = new Map<string, SnapshotBaseline>()
    const defaultBaseline = read.selected === null
      ? null
      : this.vcsBaseline(
        read.selected,
        read.selected.baseline,
        read.selected.baselineLabel,
        items,
        registry,
        baselines,
      )
    return {
      ok: true,
      value: this.snapshots.putWorking({
        context,
        selectedVcs: read.selected === null
          ? null
          : { adapter: read.selected.adapter, detection: read.selected.detection },
        logGroups: [],
        files: registry.files,
        baselines,
        source: read.selection,
        externalRoots: read.externalRoots.map((path) => ({
          path,
          displayPath: relative(context.cwd, path).replace(/\\/g, '/'),
          fileIds: entries.filter((entry) => PathCompare.isInside(path, entry.path)).map((entry) => entry.fileId),
        })),
        defaultBaseline,
        entries,
        warnings,
      }),
    }
  }

  async list(
    context: FileChangesContext,
    options?: FileChangesListOptions,
  ): Promise<FileChangesSnapshotResult> {
    const invalid = await FileChangesManager.invalidContext(context)
    if (invalid !== null) return { ok: false, code: 'invalid-context', detail: invalid }
    const preferred = options?.preferredVcs ?? 'git'
    const warnings: string[] = []
    const [selection, logGroups] = await Promise.all([
      this.detector.select(context.cwd, preferred),
      this.readLogGroups(context, warnings),
    ])
    let vcsEntries: readonly FileChangesVcsEntry[] = []
    let vcsGroups: readonly FileChangesVcsHistoryGroup[] = []
    if (selection.selected !== null) {
      const [status, history] = await Promise.all([
        selection.selected.adapter.status(selection.selected.detection).catch((error: unknown) => ({
          ok: false as const,
          detail: ErrorText.of(error),
        })),
        selection.selected.adapter.history(
          selection.selected.detection,
          FileChangesManager.vcsHistoryLimitConst,
        ).catch((error: unknown) => ({
          ok: false as const,
          detail: ErrorText.of(error),
        })),
      ])
      if (status.ok) vcsEntries = status.value.entries
      else warnings.push(`${selection.selected.adapter.id} status: ${status.detail}`)
      if (history.ok) vcsGroups = history.value
      else warnings.push(`${selection.selected.adapter.id} history: ${history.detail}`)
    }
    const currentItems = await this.listing.build({
      cwd: context.cwd,
      hasVcs: selection.selected !== null,
      vcsEntries,
      logGroups,
      warnings,
    })
    const registry: FileRegistry = { ids: new Map(), files: new Map() }
    const currentEntries = currentItems.map((item) => this.publicEntry(item, item.absolutePath, registry))
    const baselines = new Map<string, SnapshotBaseline>()
    const defaultBaseline = this.defaultBaseline(selection, currentItems, registry, baselines)
    const groups = [
      ...this.vcsHistoryGroups(context.cwd, selection, vcsGroups, registry, baselines),
      ...this.chatHistoryGroups(context.cwd, logGroups, registry, baselines),
    ].sort((left, right) => right.createdAt - left.createdAt)
    const selected = selection.selected
    const pageSize = Math.min(
      FileChangesManager.maxHistoryPageSizeConst,
      Math.max(1, options?.historyPageSize ?? FileChangesManager.defaultHistoryPageSizeConst),
    )
    return {
      ok: true,
      value: this.snapshots.put({
        context,
        selectedVcs: selected,
        logGroups,
        files: registry.files,
        baselines,
        vcs: {
          requested: selection.requested,
          selected: selected?.adapter.id ?? null,
          available: selection.available.map((item) => item.adapter.id),
          root: selected?.detection.root ?? null,
          fallbackReason: selection.fallbackReason,
        },
        defaultBaseline,
        entries: currentEntries,
        groups,
        warnings,
        pageSize,
      }),
    }
  }

  history(snapshotId: string, cursor: string): FileChangesHistoryResult {
    return this.snapshots.nextPage(snapshotId, cursor)
  }

  workingSnapshot(snapshotId: string): FileChangesWorkingTreeSnapshot | null {
    return this.snapshots.workingSnapshot(snapshotId)
  }

  fileAccess(snapshotId: string, fileId: string): FileChangesFileAccessResult {
    const found = this.snapshots.lookupFile(snapshotId, fileId)
    if (!found.ok) return found
    return {
      ok: true,
      value: {
        sessionId: found.snapshot.context.sessionId,
        cwd: found.snapshot.context.cwd,
        path: found.file.currentPath,
        nodeKind: found.file.nodeKind,
        status: found.file.status,
        ...(found.file.workingState === undefined ? {} : { workingState: found.file.workingState }),
      },
    }
  }

  async readBaseline(request: FileDiffRequest): Promise<FileChangesBaselineContentResult> {
    const found = this.snapshots.lookupDiff(request.snapshotId, request.fileId, request.baselineId)
    if (!found.ok) return found
    if (found.file.nodeKind === 'directory')
      return { ok: false, code: 'invalid-pair', detail: 'A directory has no text diff' }
    const current = await FileChangesManager.currentContent(found.baselineFile.currentPath)
    if (current.kind === 'unavailable') return { ok: true, kind: 'unavailable', detail: current.detail }
    const text = FileChangesManager.currentText(current.content)
    if (!text.ok) return { ok: true, kind: 'binary', detail: 'Working tree file is not UTF-8 text' }
    if (found.baseline.kind === 'chat')
      return { ok: false, code: 'invalid-pair', detail: 'External diffs require a VCS baseline' }
    else if (found.baseline.kind !== 'vcs') throw new Error(`Unknown snapshot baseline: ${JSON.stringify(found.baseline)}`)
    const selected = found.snapshot.selectedVcs
    if (selected === null || found.baselineFile.repositoryPath === null)
      return { ok: false, code: 'invalid-pair', detail: 'The VCS baseline has no repository path' }
    const baseline = await selected.adapter.readBaseline(selected.detection, found.baselineFile.repositoryPath, found.baseline.ref)
    if (baseline.kind === 'unavailable') return { ok: true, kind: 'unavailable', detail: baseline.detail }
    else if (baseline.kind === 'missing') return { ok: true, kind: 'missing', label: found.baseline.public.label }
    else if (baseline.kind === 'content') {
      if (baseline.content.includes('\0')) return { ok: true, kind: 'binary', detail: 'Baseline file is binary' }
      return { ok: true, kind: 'content', content: baseline.content, label: found.baseline.public.label }
    } else throw new Error(`Unknown baseline content: ${JSON.stringify(baseline)}`)
  }

  async diff(
    request: FileDiffRequest,
    execution?: FileDiffExecutionContext,
  ): Promise<FileDiffResult> {
    const found = this.snapshots.lookupDiff(
      request.snapshotId,
      request.fileId,
      request.baselineId,
    )
    if (!found.ok) return found
    if (found.file.nodeKind === 'directory')
      return { ok: false, code: 'invalid-pair', detail: 'A directory has no text diff' }
    const current = await FileChangesManager.currentContent(found.baselineFile.currentPath)
    if (current.kind === 'unavailable')
      return { ok: true, kind: 'source-unavailable', detail: current.detail }
    if (found.baseline.kind === 'vcs') {
      const selected = found.snapshot.selectedVcs
      if (selected === null || found.baselineFile.repositoryPath === null)
        return { ok: false, code: 'invalid-pair', detail: 'The VCS baseline has no repository path' }
      const baseline = await selected.adapter.readBaseline(
        selected.detection,
        found.baselineFile.repositoryPath,
        found.baseline.ref,
      )
      if (baseline.kind === 'unavailable')
        return { ok: true, kind: 'source-unavailable', detail: baseline.detail }
      return this.diffBuilder.build({
        status: found.baselineFile.status,
        completeness: 'full',
        detail: null,
        current: {
          label: 'Working tree',
          path: found.baselineFile.currentPath,
          content: current.content,
        },
        baseline: {
          label: found.baseline.public.label,
          path: found.baselineFile.baselinePath,
          content: baseline.kind === 'content' ? baseline.content : null,
        },
      }, execution)
    }
    else if (found.baseline.kind === 'chat') {
      const text = FileChangesManager.currentText(current.content)
      if (!text.ok) return text.result
      const composed = this.historyComposer.compose({
        currentPath: found.baselineFile.currentPath,
        currentContent: text.content,
        selectedGroupId: found.baseline.groupId,
        groups: found.snapshot.logGroups,
      })
      if (composed.kind === 'unavailable')
        return { ok: true, kind: 'incomplete-history', detail: composed.detail }
      return this.diffBuilder.build({
        status: found.baselineFile.status,
        completeness: composed.completeness,
        detail: composed.detail,
        current: {
          label: 'Working tree',
          path: found.baselineFile.currentPath,
          content: current.content,
        },
        baseline: {
          label: found.baseline.public.label,
          path: composed.path,
          content: composed.content,
        },
      }, execution)
    }
    else
      throw new Error(`Unknown snapshot baseline: ${JSON.stringify(found.baseline)}`)
  }

  private async readLogGroups(
    context: FileChangesContext,
    warnings: string[],
  ): Promise<readonly FileChangesLogGroup[]> {
    if (context.agent === null) return []
    const source = this.logReaders.get(context.agent.agentId)
    if (!source) throw new Error(`No log source for ${context.agent.agentId}`)
    try {
      const ref = await this.transcriptResolver.resolve({
        agentId: context.agent.agentId,
        cwd: context.cwd,
        nativeSessionId: context.agent.nativeSessionId,
      })
      return ref === null ? [] : await source.load(ref, context.cwd)
    }
    catch (error) {
      warnings.push(`Transcript history: ${ErrorText.of(error)}`)
      return []
    }
  }

  private defaultBaseline(
    selection: Awaited<ReturnType<FileChangesVcsDetector['select']>>,
    items: readonly FileChangesListingItem[],
    registry: FileRegistry,
    baselines: Map<string, SnapshotBaseline>,
  ): FileChangeBaseline | null {
    const selected = selection.selected
    if (selected === null) return null
    return this.vcsBaseline(
      selected,
      selected.adapter.defaultBaselineRef,
      selected.adapter.defaultBaselineRef.revision,
      items,
      registry,
      baselines,
    )
  }

  private vcsBaseline(
    selected: { adapter: FileChangesVcs; detection: FileChangesVcsDetection },
    ref: FileChangesVcsBaselineRef,
    label: string,
    items: readonly FileChangesListingItem[],
    registry: FileRegistry,
    baselines: Map<string, SnapshotBaseline>,
  ): FileChangeBaseline {
    const baselineId = randomUUID()
    const baseline: FileChangeBaseline = {
      baselineId,
      kind: ref.kind,
      label,
      revision: ref.revision,
      createdAt: null,
    }
    const files = new Map<string, SnapshotBaselineFile>()
    for (const item of items) {
      if (item.entry.location !== 'workspace'
        || item.entry.nodeKind !== 'file'
        || item.repositoryPath === null)
        continue
      const fileId = this.fileId(item.absolutePath, item.entry.nodeKind, item.entry.status, registry)
      const repositoryPath = selected.adapter.id === 'git'
        && item.entry.status === 'renamed'
        && item.previousRepositoryPath !== null
        ? item.previousRepositoryPath
        : item.repositoryPath
      files.set(fileId, {
        currentPath: item.absolutePath,
        baselinePath: item.entry.status === 'renamed' && item.entry.previousPath !== null
          ? item.entry.previousPath
          : item.absolutePath,
        repositoryPath,
        status: item.entry.status,
      })
    }
    baselines.set(baselineId, { public: baseline, kind: 'vcs', ref, files })
    return baseline
  }

  private vcsHistoryGroups(
    cwd: string,
    selection: Awaited<ReturnType<FileChangesVcsDetector['select']>>,
    groups: readonly FileChangesVcsHistoryGroup[],
    registry: FileRegistry,
    baselines: Map<string, SnapshotBaseline>,
  ): FileChangeGroup[] {
    const selected = selection.selected
    if (selected === null) return []
    return groups.map((group) => {
      const baselineId = randomUUID()
      const ref = selected.adapter.historyBaselineRef(group.revision)
      // The groupId's prefix, which is the one thing the dropped `kind` field was still used for.
      const kind = ref.kind
      const baseline: FileChangeBaseline = {
        baselineId,
        kind,
        label: group.label,
        revision: group.revision,
        createdAt: group.createdAt,
      }
      const files = new Map<string, SnapshotBaselineFile>()
      const entries = group.entries.map((entry) => {
        const item = this.listing.fromHistoryEntry(cwd, entry)
        const publicEntry = this.publicEntry(item, item.absolutePath, registry)
        if (entry.nodeKind === 'file')
          files.set(publicEntry.fileId, {
            currentPath: item.absolutePath,
            baselinePath: item.absolutePath,
            repositoryPath: item.repositoryPath,
            status: item.entry.status,
          })
        return publicEntry
      })
      baselines.set(baselineId, { public: baseline, kind: 'vcs', ref, files })
      return {
        groupId: `${kind}:${group.id}`,
        baseline,
        label: group.label,
        message: group.message,
        author: group.author,
        createdAt: group.createdAt,
        entries: FileChangesListing.byName(entries),
      }
    })
  }

  private chatHistoryGroups(
    cwd: string,
    groups: readonly FileChangesLogGroup[],
    registry: FileRegistry,
    baselines: Map<string, SnapshotBaseline>,
  ): FileChangeGroup[] {
    const recent = groups.slice(-FileChangesManager.chatHistoryLimitConst)
    const offset = groups.length - recent.length
    return recent.map((group, recentIndex) => {
      const groupIndex = offset + recentIndex
      const baseline: FileChangeBaseline = {
        baselineId: randomUUID(),
        kind: 'chat-message',
        label: group.message,
        revision: group.groupId,
        createdAt: group.createdAt,
      }
      const files = new Map<string, SnapshotBaselineFile>()
      const entries = FileChangesManager.lastGroupMutations(group).map((mutation) => {
        const currentPath = FileChangesManager.latestPathOf(mutation.path, groups.slice(groupIndex + 1))
        const item = this.listing.fromLogMutation(cwd, mutation)
        const publicEntry = this.publicEntry(item, currentPath, registry)
        files.set(publicEntry.fileId, {
          currentPath,
          baselinePath: mutation.path,
          repositoryPath: null,
          status: mutation.status,
        })
        return publicEntry
      })
      baselines.set(baseline.baselineId, {
        public: baseline,
        kind: 'chat',
        groupId: group.groupId,
        files,
      })
      return {
        groupId: `chat-message:${group.groupId}`,
        baseline,
        label: group.message,
        message: group.message,
        author: null,
        createdAt: group.createdAt,
        entries: FileChangesListing.byName(entries),
      }
    })
  }

  private publicEntry(
    item: FileChangesListingItem,
    identityPath: string,
    registry: FileRegistry,
  ): FileChangeEntry {
    return {
      fileId: this.fileId(identityPath, item.entry.nodeKind, item.entry.status, registry),
      ...item.entry,
    }
  }

  private fileId(
    identityPath: string,
    nodeKind: FileChangeEntry['nodeKind'],
    status: FileChangeEntry['status'],
    registry: FileRegistry,
  ): string {
    const key = PathCompare.comparable(identityPath)
    const existing = registry.ids.get(key)
    if (existing) return existing
    const fileId = randomUUID()
    registry.ids.set(key, fileId)
    registry.files.set(fileId, { fileId, currentPath: identityPath, nodeKind, status })
    return fileId
  }

  private static lastGroupMutations(group: FileChangesLogGroup): FileChangesLogMutation[] {
    const found = new Map<string, FileChangesLogMutation>()
    for (const mutation of group.mutations) {
      if (mutation.kind === 'move' && mutation.previousPath !== null)
        found.delete(PathCompare.comparable(mutation.previousPath))
      found.set(PathCompare.comparable(mutation.path), mutation)
    }
    return [...found.values()]
  }

  private static latestPathOf(path: string, groups: readonly FileChangesLogGroup[]): string {
    let current = path
    for (const group of groups)
      for (const mutation of group.mutations)
        if (mutation.kind === 'move'
          && mutation.previousPath !== null
          && PathCompare.comparable(mutation.previousPath) === PathCompare.comparable(current))
          current = mutation.path
    return current
  }

  private static async invalidContext(context: FileChangesContext): Promise<string | null> {
    if (!context.sessionId.trim()) return 'sessionId is empty'
    if (context.agent !== null && !context.agent.nativeSessionId.trim())
      return 'nativeSessionId is empty'
    if (!context.cwd.trim()) return 'cwd is empty'
    try { return (await stat(context.cwd)).isDirectory() ? null : 'cwd is not a directory' }
    catch { return 'cwd is not a directory' }
  }

  private static async currentContent(path: string): Promise<
    | { kind: 'content'; content: Buffer | null }
    | { kind: 'unavailable'; detail: string }
  > {
    try {
      // Measured first. The diff builder refuses anything over its ceiling, but only once the whole
      // buffer exists - so a changed four-gigabyte file in the list was either allocated whole or
      // reported as "Current file cannot be read", which is a wrong explanation for a file that
      // reads perfectly well.
      const size = (await stat(path)).size
      if (size > FileDiffBuilder.maxContentBytesConst)
        return { kind: 'unavailable', detail: `Current file exceeds ${FileDiffBuilder.maxContentLabelConst}` }
      return { kind: 'content', content: await readFile(path) }
    }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'content', content: null }
      return {
        kind: 'unavailable',
        detail: `Current file cannot be read: ${ErrorText.of(error)}`,
      }
    }
  }

  private static currentText(content: Buffer | null):
    | { ok: true; content: string | null }
    | { ok: false; result: FileDiffResult } {
    if (content === null) return { ok: true, content: null }
    if (content.includes(0))
      return { ok: false, result: { ok: true, kind: 'binary', detail: 'Working tree file is binary' } }
    const text = content.toString('utf8')
    if (!Buffer.from(text, 'utf8').equals(content))
      return {
        ok: false,
        result: { ok: true, kind: 'binary', detail: 'Working tree file is not valid UTF-8 text' },
      }
    return { ok: true, content: text }
  }
}
