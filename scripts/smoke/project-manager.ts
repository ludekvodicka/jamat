/**
 * End-to-end proof that lib-orchestrator's ProjectManager drives the whole chain against a real
 * disk: an empty catalog, a saved config, a listing with its grouping, a created project with its
 * hook, both provider histories, a rename that carries them, a startup sweep that finishes an
 * interrupted operation, an archive and a two-phase delete.
 *
 * Unit tests use fake subsystems and injected failures, so this is the only place the composition
 * runs over real files. No Electron: plain Node through tsx.
 *
 * Everything happens under one temporary root - the config directory, the state root, and BOTH
 * provider homes - so the machine's own ~/.claude, ~/.codex and %LOCALAPPDATA%\jamat-v3 are never
 * read and never written.
 */
import { SmokeHarness, SmokeRun } from './smokeHarness.js'
import { CatalogSection } from '../../lib-orchestrator/projectManager/catalog/catalogSection.js'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { ConfigStore } from '../../lib-orchestrator/configStore/configStore.js'
import { ProjectManager } from '../../lib-orchestrator/projectManager/projectManager.js'
import type {
  CatalogCategoryDto,
  DisplayEntry,
  ProjectsOpResult,
} from '../../lib-orchestrator/projectManager/projectManagerApi.types.js'
import { ClaudeProjectsLocator } from '../../lib-orchestrator/projectManager/providers/claude/claudeProjectsLocator.js'
import { OrchestratorPaths } from '../../lib-orchestrator/shared/orchestratorPaths.js'

class SmokeProjectManager extends SmokeHarness {
  private static readonly configIdentityConst = 'smoke-identity'
  private static readonly channelConst = 'development'
  private static readonly categoryIdConst = 'smoke'
  private static readonly hookMarkerNameConst = 'hook-marker.txt'
  private static readonly exampleConfigConst = join(
    import.meta.dirname, '..', '..', 'configs', 'config.example.json',
  )

  private readonly configDir: string
  private readonly claudeHome: string
  private readonly codexHome: string
  private readonly projectsRoot: string
  private readonly hookScript: string
  private readonly errors: string[] = []
  private readonly claudeSessionId = randomUUID()
  private readonly codexSessionId = randomUUID()
  private readonly sweptSessionId = randomUUID()
  private readonly otherClaudeSessionId = randomUUID()
  private readonly otherCodexSessionId = randomUUID()
  private sessionIndexBefore: Buffer = Buffer.alloc(0)

  private constructor(private readonly root: string) {
    super()
    this.configDir = join(root, 'config')
    this.claudeHome = join(root, 'claude')
    this.codexHome = join(root, 'codex')
    this.projectsRoot = join(root, 'roots', 'smoke')
    this.hookScript = join(root, 'after-create.cjs')
  }

  static async run(): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-projects-smoke-'))
    // Named before the first ProjectManager: OrchestratorPaths reads it when it builds a path.
    process.env.JAMAT_V3_LOCAL_STATE_DIR = join(root, 'state')
    try {
      await new SmokeProjectManager(root).execute()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  private async execute(): Promise<void> {
    this.seed()
    const manager = this.newManager()
    await manager.start()
    this.check('a missing config file is an empty catalog',
      (await manager.listCategories()).length === 0)

    await this.checkConfig(manager)
    await this.checkListing(manager)
    const projectPath = await this.checkCreate(manager)
    this.seedHistories(projectPath, this.claudeSessionId, this.codexSessionId, '10-15-00')
    await this.checkSessions(manager)
    await this.checkRename(manager, projectPath)
    await this.checkMovePrefix(manager)
    const second = await this.checkSweep()
    await this.checkArchive(second)
    await this.checkDelete(second)

    this.check(`nothing was reported through onError (${this.errors.join(' | ')})`,
      this.errors.length === 0)
    console.log(`\nsmoke-project-manager: ${this.passed} checks passed`)
  }

  /** A client of the library builds the one writer itself, exactly as the client shell does. */
  private newManager(): ProjectManager {
    return new ProjectManager({
      configStore: ConfigStore.load(this.configDir, {
        snapshotsDirectory: OrchestratorPaths.configSnapshotsDirectory(
          SmokeProjectManager.configIdentityConst,
          SmokeProjectManager.channelConst,
        ),
        report: (message) => { this.errors.push(message) },
        // The same claim the client shell makes: the key-less snapshots on a machine that has been
        // through an upgrade are the catalog's, and only a consumer can say so.
        legacySnapshotSection: CatalogSection.spec.key,
      }),
      configIdentity: SmokeProjectManager.configIdentityConst,
      channel: SmokeProjectManager.channelConst,
      onError: (message) => { this.errors.push(message) },
      claudeHome: this.claudeHome,
      codexHome: this.codexHome,
    })
  }

  /** The disk as it is before anything is asked of the library. */
  private seed(): void {
    for (const name of ['node_modules', 'Archived', 'temporaryThing', join('Plugins', 'foo')])
      mkdirSync(join(this.projectsRoot, name), { recursive: true })
    mkdirSync(join(this.claudeHome, 'projects'), { recursive: true })
    mkdirSync(join(this.codexHome, 'sessions'), { recursive: true })

    const other = join(this.projectsRoot, 'OtherProject')
    mkdirSync(other, { recursive: true })
    writeFileSync(join(other, 'readme.md'), 'the project to be deleted', 'utf8')
    this.seedHistories(other, this.otherClaudeSessionId, this.otherCodexSessionId, '08-00-00')

    // Codex's own append-only index. This file belongs to every session of the store, so the delete
    // must leave it exactly as it is - which is what the last check compares byte for byte.
    const sessionIndex = join(this.codexHome, 'session_index.jsonl')
    writeFileSync(sessionIndex, [
      `{"id":"${this.codexSessionId}","thread_name":"Smoke thread"}`,
      `{"id":"${this.otherCodexSessionId}","thread_name":"Doomed thread"}`,
      '',
    ].join('\n'), 'utf8')
    this.sessionIndexBefore = readFileSync(sessionIndex)

    writeFileSync(this.hookScript, [
      "const { writeFileSync } = require('node:fs')",
      "const { join } = require('node:path')",
      'const directory = process.argv[2]',
      `writeFileSync(join(directory, ${JSON.stringify(SmokeProjectManager.hookMarkerNameConst)}), directory)`,
      '',
    ].join('\n'), 'utf8')
  }

  /** The shipped example is the template, with every path pointed into the temporary root. */
  private async checkConfig(manager: ProjectManager): Promise<void> {
    const example = JSON.parse(
      readFileSync(SmokeProjectManager.exampleConfigConst, 'utf8'),
    ) as { categories: CatalogCategoryDto[] }
    const [first, second] = example.categories
    first.id = SmokeProjectManager.categoryIdConst
    first.label = 'Smoke'
    first.path = this.projectsRoot
    first.afterCreate = { command: process.execPath, args: [this.hookScript, '{dir}'] }
    second.path = join(this.root, 'not-mounted')
    // The example lands on disk whole: what surrounds the section here is the real thing a save of
    // the section alone has to leave standing.
    const configFile = join(this.configDir, 'config.json')
    mkdirSync(this.configDir, { recursive: true })
    writeFileSync(configFile, JSON.stringify(example), 'utf8')

    const saved = await manager.saveConfig(example.categories)
    this.check('the example-shaped catalog is accepted', saved.ok)
    const loaded = SmokeProjectManager.valueOf(await manager.getConfig(), 'getConfig')
    this.check('keys this build does not know survive the round trip',
      typeof loaded[0]['_README_id'] === 'string')
    const onDisk = JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown>
    this.check('a key beside the section is where the hand that wrote it left it',
      typeof onDisk['_README'] === 'string')
    const categories = await manager.listCategories()
    this.check('a category whose root is missing stays listed as unavailable',
      categories.length === 2 && categories[0].available && !categories[1].available)
  }

  private async checkListing(manager: ProjectManager): Promise<void> {
    const listed = SmokeProjectManager.valueOf(
      await manager.listProjects(SmokeProjectManager.categoryIdConst, { sort: 'alpha' }),
      'listProjects',
    )
    const names = listed.projects.map((project) => project.name)
    this.check('a flattened container is listed as container/child', names.includes('Plugins/foo'))
    this.check('hiddenFolders, Archived and the container itself are not projects',
      !names.includes('node_modules') && !names.includes('Archived') && !names.includes('Plugins'))
    const virtual = SmokeProjectManager.virtualFolderOf(listed.entries, 'temporary')
    this.check('a virtual folder groups the names that match its prefix',
      virtual !== null
      && virtual.title === 'Temporary'
      && virtual.children.map((child) => child.name).join() === 'temporaryThing')
    this.check('an alphabetical listing opens no provider store',
      listed.projects.every((project) => project.lastActivity === null))
  }

  private async checkCreate(manager: ProjectManager): Promise<string> {
    const created = SmokeProjectManager.valueOf(
      await manager.createProject(SmokeProjectManager.categoryIdConst, 'RenameMe'),
      'createProject',
    )
    this.check('the project directory was created', existsSync(created.path))
    const marker = join(created.path, SmokeProjectManager.hookMarkerNameConst)
    this.check('the afterCreate hook ran in the new directory',
      existsSync(marker) && readFileSync(marker, 'utf8') === created.path)
    return created.path
  }

  private async checkSessions(manager: ProjectManager): Promise<void> {
    const sessions = SmokeProjectManager.valueOf(
      await manager.listProjectSessions(SmokeProjectManager.categoryIdConst, 'RenameMe'),
      'listProjectSessions',
    )
    this.check('the Claude session is listed under its slug',
      sessions.claude.length === 1
      && sessions.claude[0].nativeSessionId === this.claudeSessionId
      && sessions.claude[0].title === 'smoke-session')
    this.check('the Codex session is listed under its thread name',
      sessions.codex.length === 1
      && sessions.codex[0].nativeSessionId === this.codexSessionId
      && sessions.codex[0].title === 'Smoke thread')
    this.check('merged holds both providers, newest first',
      sessions.merged.length === 2
      && sessions.merged[0].agentId === 'claude'
      && sessions.merged[0].lastActivity >= sessions.merged[1].lastActivity)
    const limited = SmokeProjectManager.valueOf(
      await manager.listProjectSessions(SmokeProjectManager.categoryIdConst, 'RenameMe', { limit: 1 }),
      'listProjectSessions',
    )
    this.check('merged honours the limit', limited.merged.length === 1)
  }

  private async checkRename(manager: ProjectManager, oldPath: string): Promise<void> {
    const report = SmokeProjectManager.valueOf(
      await manager.renameProject(SmokeProjectManager.categoryIdConst, 'RenameMe', 'RenamedProject'),
      'renameProject',
    )
    const newPath = join(this.projectsRoot, 'RenamedProject')
    this.check('the project directory moved',
      existsSync(newPath) && !existsSync(oldPath)
      && report.providers.claude === 'done' && report.providers.codex === 'done'
      && report.leftoverCount === 0)
    this.check('the Claude store directory was renamed with it',
      existsSync(this.claudeStore(newPath)) && !existsSync(this.claudeStore(oldPath)))
    const transcript = readFileSync(
      join(this.claudeStore(newPath), `${this.claudeSessionId}.jsonl`), 'utf8',
    )
    this.check('all three shapes of the path were rewritten in the transcript',
      SmokeProjectManager.holdsEveryShape(transcript, newPath)
      && !SmokeProjectManager.holdsAnyShape(transcript, oldPath))
    const rollout = readFileSync(this.codexRolloutFile(this.codexSessionId, '10-15-00'), 'utf8')
    this.check('the Codex rollout was rewritten where it lies',
      rollout.includes(SmokeProjectManager.escaped(newPath))
      && !rollout.includes(SmokeProjectManager.escaped(oldPath)))
  }

  /**
   * Moving between virtual folders over the real config: the move, the no-op, and the three
   * refusals. The prefixes come from `config.example.json`, so a folder renamed there fails here
   * rather than silently in the launcher.
   */
  private async checkMovePrefix(manager: ProjectManager): Promise<void> {
    const listed = SmokeProjectManager.valueOf(
      await manager.listProjects(SmokeProjectManager.categoryIdConst, { sort: 'alpha' }),
      'listProjects',
    )
    this.check('the listing carries every folder the category defines',
      listed.virtualFolders.some((folder) => folder.prefix === 'temporary'))

    const moved = SmokeProjectManager.valueOf(
      await manager.moveProjectPrefix(
        SmokeProjectManager.categoryIdConst, 'RenamedProject', 'temporary',
      ),
      'moveProjectPrefix',
    )
    const inside = join(this.projectsRoot, 'temporaryRenamedProject')
    this.check('the project moved into the virtual folder and took its history with it',
      moved.directoryRenamed && existsSync(inside) && existsSync(this.claudeStore(inside)))

    const again = await manager.moveProjectPrefix(
      SmokeProjectManager.categoryIdConst, 'temporaryRenamedProject', 'temporary',
    )
    this.check('moving a project into the folder it is already in does nothing and refuses nothing',
      again.ok && !again.value.directoryRenamed && again.value.operationId === null
      && existsSync(inside))

    // The same answer the check above takes, over a name that is on no disk: the no-op must not
    // stand in for a project that is not there.
    const missing = await manager.moveProjectPrefix(
      SmokeProjectManager.categoryIdConst, 'NeverCreated', null,
    )
    this.check('a project that is not there is refused, not called already where it was sent',
      !missing.ok && missing.code === 'project-not-found')

    const invented = await manager.moveProjectPrefix(
      SmokeProjectManager.categoryIdConst, 'temporaryRenamedProject', 'notInTheConfig',
    )
    this.check('a prefix the category does not define is refused',
      !invented.ok && invented.code === 'unknown-virtual-folder' && existsSync(inside))

    const flattened = await manager.moveProjectPrefix(
      SmokeProjectManager.categoryIdConst, 'Plugins/foo', 'temporary',
    )
    this.check('a project inside a flattened container is refused',
      !flattened.ok && flattened.code === 'invalid-name'
      && existsSync(join(this.projectsRoot, 'Plugins', 'foo')))

    const back = SmokeProjectManager.valueOf(
      await manager.moveProjectPrefix(
        SmokeProjectManager.categoryIdConst, 'temporaryRenamedProject', null,
      ),
      'moveProjectPrefix out',
    )
    this.check('the project came back out of the folder',
      back.directoryRenamed && existsSync(join(this.projectsRoot, 'RenamedProject')))
  }

  /**
   * A crash cannot be staged from Node, so what a crash leaves behind is: a journal whose directory
   * rename already happened and whose history migration did not, and a leftover copy the operation
   * could not remove. A fresh ProjectManager over the same state has to finish both.
   */
  private async checkSweep(): Promise<ProjectManager> {
    const swept = join(this.projectsRoot, 'SweptProject')
    const interrupted = join(this.projectsRoot, 'PendingOld')
    mkdirSync(this.claudeStore(swept), { recursive: true })
    mkdirSync(swept, { recursive: true })
    const transcript = join(this.claudeStore(swept), `${this.sweptSessionId}.jsonl`)
    writeFileSync(transcript, SmokeProjectManager.claudeTranscript(interrupted, this.sweptSessionId), 'utf8')
    const operationId = randomUUID()
    const journal = join(
      OrchestratorPaths.relocationJournalsDirectory(
        SmokeProjectManager.configIdentityConst, SmokeProjectManager.channelConst,
      ),
      `${operationId}.json`,
    )
    mkdirSync(dirname(journal), { recursive: true })
    writeFileSync(journal, JSON.stringify({
      schemaVersion: 1,
      operationId,
      kind: 'rename',
      oldPath: interrupted,
      newPath: swept,
      directoryRenamed: true,
      steps: [],
    }), 'utf8')
    const stale = join(this.root, 'stale-copy.jsonl')
    writeFileSync(stale, 'a copy the last run could not remove', 'utf8')
    const leftovers = OrchestratorPaths.relocationLeftoversFile(
      SmokeProjectManager.configIdentityConst, SmokeProjectManager.channelConst,
    )
    writeFileSync(leftovers, JSON.stringify({
      schemaVersion: 1,
      entries: [{ kind: 'delete', path: stale, operationId, recordedAt: Date.now() }],
    }), 'utf8')

    const second = this.newManager()
    await second.start()

    this.check('the sweep finished the interrupted migration and dropped its journal',
      !existsSync(journal)
      && SmokeProjectManager.holdsEveryShape(readFileSync(transcript, 'utf8'), swept))
    const remaining = JSON.parse(readFileSync(leftovers, 'utf8')) as { entries: unknown[] }
    this.check('the sweep removed the recorded leftover and forgot it',
      !existsSync(stale) && remaining.entries.length === 0)
    return second
  }

  private async checkArchive(manager: ProjectManager): Promise<void> {
    SmokeProjectManager.valueOf(
      await manager.archiveProject(SmokeProjectManager.categoryIdConst, 'RenamedProject'),
      'archiveProject',
    )
    const archived = join(this.projectsRoot, 'Archived', 'RenamedProject')
    this.check('the project sits under Archived/', existsSync(archived))
    const transcript = join(this.claudeStore(archived), `${this.claudeSessionId}.jsonl`)
    this.check('the Claude history followed it into the archive',
      existsSync(transcript)
      && SmokeProjectManager.holdsEveryShape(readFileSync(transcript, 'utf8'), archived))
    const rollout = readFileSync(this.codexRolloutFile(this.codexSessionId, '10-15-00'), 'utf8')
    this.check('the Codex rollout names the archived path',
      rollout.includes(SmokeProjectManager.escaped(archived)))
  }

  private async checkDelete(manager: ProjectManager): Promise<void> {
    const preview = SmokeProjectManager.valueOf(
      await manager.previewDelete(SmokeProjectManager.categoryIdConst, 'OtherProject'),
      'previewDelete',
    )
    const encodedDirectory = preview.claude.encodedDirectory
    this.check('the preview names the project, the Claude store and the Codex rollouts',
      preview.projectFileCount === 1
      && encodedDirectory !== null
      && preview.claude.transcriptFiles.length === 1
      && preview.codex.rolloutFiles.length === 1)
    if (encodedDirectory === null) throw new Error('FAILED: the preview found no Claude store')

    const report = SmokeProjectManager.valueOf(await manager.executeDelete(preview.token), 'executeDelete')
    this.check('everything the preview named is gone',
      report.leftoverCount === 0
      && !existsSync(join(this.projectsRoot, 'OtherProject'))
      && !existsSync(encodedDirectory)
      && !existsSync(preview.codex.rolloutFiles[0]))
    this.check("Codex's own session_index.jsonl is byte-for-byte what it was",
      readFileSync(join(this.codexHome, 'session_index.jsonl')).equals(this.sessionIndexBefore))
  }

  /** One Claude transcript and one Codex rollout for a project, the Claude one the more recent. */
  private seedHistories(
    projectPath: string,
    claudeSessionId: string,
    codexSessionId: string,
    rolloutTime: string,
  ): void {
    const store = this.claudeStore(projectPath)
    mkdirSync(store, { recursive: true })
    const transcript = join(store, `${claudeSessionId}.jsonl`)
    writeFileSync(transcript, SmokeProjectManager.claudeTranscript(projectPath, claudeSessionId), 'utf8')
    const rollout = this.codexRolloutFile(codexSessionId, rolloutTime)
    mkdirSync(dirname(rollout), { recursive: true })
    writeFileSync(rollout, SmokeProjectManager.codexRollout(projectPath, codexSessionId), 'utf8')
    // Fixed times, so "newest first" is an assertion and not a race between two writes.
    utimesSync(rollout, new Date(2026, 0, 2), new Date(2026, 0, 2))
    utimesSync(transcript, new Date(2026, 0, 3), new Date(2026, 0, 3))
  }

  private claudeStore(projectPath: string): string {
    return join(this.claudeHome, 'projects', ClaudeProjectsLocator.encodeProjectDir(projectPath))
  }

  private codexRolloutFile(sessionId: string, time: string): string {
    const now = new Date()
    const year = String(now.getFullYear())
    const month = String(now.getMonth() + 1).padStart(2, '0')
    const day = String(now.getDate()).padStart(2, '0')
    return join(
      this.codexHome, 'sessions', year, month, day,
      `rollout-${year}-${month}-${day}T${time}-${sessionId}.jsonl`,
    )
  }

  /**
   * The three shapes a project path takes in a Claude transcript, written as raw text - each of them
   * a whole JSON string value, which is how a transcript really holds a path and what the rewriter's
   * boundary rule replaces: a path is either closed by its quote or continues with a separator.
   */
  private static claudeTranscript(projectPath: string, sessionId: string): string {
    return [
      `{"type":"summary","sessionId":"${sessionId}","slug":"smoke-session"}`,
      `{"type":"user","sessionId":"${sessionId}","cwd":"${SmokeProjectManager.escaped(projectPath)}",`
      + `"projectRoot":"${SmokeProjectManager.forwardSlashed(projectPath)}",`
      + `"storeDirectory":"${ClaudeProjectsLocator.encodeProjectDir(projectPath)}",`
      + '"message":{"content":"Smoke prompt"}}',
      '',
    ].join('\n')
  }

  private static codexRollout(projectPath: string, sessionId: string): string {
    const stamp = '2026-01-02T09:30:00.000Z'
    return [
      `{"timestamp":"${stamp}","type":"session_meta","payload":{"id":"${sessionId}",`
      + `"timestamp":"${stamp}","cwd":"${SmokeProjectManager.escaped(projectPath)}"}}`,
      `{"timestamp":"${stamp}","type":"event_msg","payload":{"type":"user_message","message":"Smoke prompt"}}`,
      '',
    ].join('\n')
  }

  private static holdsEveryShape(content: string, projectPath: string): boolean {
    return content.includes(SmokeProjectManager.escaped(projectPath))
      && content.includes(SmokeProjectManager.forwardSlashed(projectPath))
      && content.includes(ClaudeProjectsLocator.encodeProjectDir(projectPath))
  }

  private static holdsAnyShape(content: string, projectPath: string): boolean {
    return content.includes(SmokeProjectManager.escaped(projectPath))
      || content.includes(SmokeProjectManager.forwardSlashed(projectPath))
      || content.includes(ClaudeProjectsLocator.encodeProjectDir(projectPath))
  }

  /** What a JSON string literal holding this path looks like in the raw file. */
  private static escaped(projectPath: string): string {
    return JSON.stringify(projectPath).slice(1, -1)
  }

  private static forwardSlashed(projectPath: string): string {
    return projectPath.replace(/\\/g, '/')
  }

  private static virtualFolderOf(
    entries: readonly DisplayEntry[],
    prefix: string,
  ): Extract<DisplayEntry, { kind: 'virtualFolder' }> | null {
    for (const entry of entries)
      if (entry.kind === 'virtualFolder' && entry.prefix === prefix) return entry
    return null
  }

  private static valueOf<T>(result: ProjectsOpResult<T>, operation: string): T {
    if (!result.ok)
      throw new Error(`FAILED: ${operation} refused with ${result.code}: ${result.detail}`)
    return result.value
  }

}

void SmokeProjectManager.run().catch((error: unknown) => SmokeRun.failed('smoke-project-manager', error))
