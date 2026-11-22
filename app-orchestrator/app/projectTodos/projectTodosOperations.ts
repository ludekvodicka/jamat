import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, unlinkSync, unwatchFile, watchFile, writeFileSync, type Stats } from 'node:fs'
import { userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { z } from 'zod'

import type { AppOperationMap } from '../../../lib-orchestrator/clientApi/appOperationMap'
import {
  ProjectTodos,
  type ProjectTodoItem,
  type ProjectTodoOperation,
  type ProjectTodosApplyResult,
  type ProjectTodosListResult,
  type ProjectTodosPlace,
  type ProjectTodosQuery,
  type ProjectTodosRestoreResult,
  type ProjectTodosReadRefusal,
} from '../../../lib-orchestrator/clientApi/projectTodos'
import type { RemoteControlSessionSelector, RemoteControlStepResult } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import { RemoteControlOutcome } from '../../../lib-orchestrator/remoteControl/remoteControlOutcome'
import type { RemoteControlRegistry } from '../../../lib-orchestrator/remoteControl/remoteControlRegistry'
import { RemoteControlZod } from '../../../lib-orchestrator/remoteControl/remoteControlSchemas'
import type { SessionManager } from '../../../lib-orchestrator/sessionManager/sessionManager'
import type { TabControlTodosOpenedDto } from '../../../lib-orchestrator/shared/tabRequestPort.types'
import { ErrnoCode } from '../../../lib-orchestrator/shared/errnoCode'
import { ErrorText } from '../../../lib-orchestrator/shared/errorText'
import { WindowsHeldFile } from '../../../lib-orchestrator/shared/windowsHeldFile'

type ProjectTodosRead =
  | { ok: true; text: string | null; items: readonly ProjectTodoItem[] }
  | { ok: false; code: Extract<ProjectTodosReadRefusal, `file-${string}`>; detail: string }

type ProjectTodosTarget =
  | { ok: true; project: string; file: string }
  | { ok: false; code: Exclude<ProjectTodosReadRefusal, `file-${string}`>; detail: string }

type ProjectTodosSession =
  | { ok: true; sessionId: string; tabTitle: string }
  | { ok: false; code: 'session-not-found' | 'session-ambiguous'; detail: string }

/** Who a list is asked for: a session (its catalog project) or a directory inside a catalog project. */
interface ProjectTodosAddress {
  session?: RemoteControlSessionSelector
  project?: string
}

export interface ProjectTodosOperationsDeps {
  sessions: Pick<SessionManager, 'catalogProject' | 'catalogProjectOf' | 'snapshot'>
  openTodos(sessionId: string, tabTitle: string, view: ProjectTodosPlace): Promise<RemoteControlStepResult<TabControlTodosOpenedDto>>
  now(): Date
  /** The operating-system user recorded as the author of a new task. */
  user: string
  onChanged(project: string): void
}

/**
 * The one owner of the project todo lists. A caller names a session or a project directory and this
 * class resolves the catalog project, so no caller chooses which file it writes. A change is applied
 * to the file as it is on disk at that moment, and the write is dropped and done again when the file
 * changed between that read and the replace, so an `svn update` or an agent's edit is never lost.
 */
export class ProjectTodosOperations {
  /** Stat polling, because `.aidocs/` and the file itself may not exist yet. */
  private static readonly watchIntervalMsConst = 1_500
  private static readonly writeAttemptsConst = 3
  /** Per project; the oldest is forgotten first. */
  private static readonly removedKeptConst = 50
  private readonly deps: ProjectTodosOperationsDeps
  private readonly watched = new Map<string, (current: Stats, previous: Stats) => void>()
  /**
   * The tasks a `remove` took out since this orchestrator started, so `projectTodos.restore` needs only
   * the id. Memory only: a removal by hand, by `svn update` or before a restart is not here.
   */
  private readonly removed = new Map<string, ProjectTodoItem[]>()

  constructor(deps: ProjectTodosOperationsDeps) {
    this.deps = deps
  }

  register(registry: Pick<RemoteControlRegistry, 'registrar'>): void {
    const op = registry.registrar<AppOperationMap>()
    const address = {
      session: RemoteControlZod.sessionSelector.optional(),
      project: RemoteControlZod.text(4_096).optional(),
    }
    op('projectTodos.list', {
      kind: 'read',
      description: 'The todo list of a catalog project, named by a session or by a directory inside the project; '
        + 'filter by text (#category, @author), category ("" for none), colour ("" for none), author and done.',
      input: z.strictObject({
        ...address,
        filter: z.strictObject({
          text: RemoteControlZod.string(1_000).optional(),
          category: RemoteControlZod.string(ProjectTodos.categoryMaxConst).optional(),
          color: RemoteControlZod.string(20).optional(),
          author: RemoteControlZod.string(ProjectTodos.authorMaxConst).optional(),
          done: z.boolean({ error: 'done must be true or false' }).optional(),
        }).optional(),
      }),
      run: async (body) => RemoteControlOutcome.of(await this.list(body, body.filter)),
    })
    op('projectTodos.apply', {
      kind: 'write',
      description: 'Apply one change (add, edit, toggle, remove, restore) to the todo list of a catalog project and answer the stored list.',
      input: z.strictObject({ ...address, operation: RemoteControlZod.ownedObject<ProjectTodoOperation>() }),
      run: async (body) => RemoteControlOutcome.of(await this.apply(body, body.operation)),
    })
    op('projectTodos.restore', {
      kind: 'write',
      description: 'Put back a task this orchestrator removed since it started, by its id, and answer the stored list.',
      input: z.strictObject({ ...address, id: RemoteControlZod.text(64) }),
      run: async (body) => RemoteControlOutcome.of(await this.restore(body, body.id)),
    })
    op('projectTodos.open', {
      kind: 'write',
      description: "Open the project todo list of the session's terminal tab: in its split (the default) or in its File Tools sidebar tab.",
      input: z.strictObject({
        session: RemoteControlZod.sessionSelector,
        view: z.enum(['split', 'sidebar'], { error: 'view must be split or sidebar' }).optional(),
      }),
      run: async (body) => {
        const session = this.sessionOf(body.session)
        if (!session.ok) return RemoteControlOutcome.of(session)
        return this.deps.openTodos(session.sessionId, session.tabTitle, body.view ?? 'split')
      },
    })
  }

  /** The login name of this computer's user; a task records it as its author. */
  static osUser(): string {
    try { return userInfo().username }
    catch { return process.env.USERNAME ?? process.env.USER ?? '' }
  }

  stop(): void {
    for (const [file, listener] of this.watched) unwatchFile(file, listener)
    this.watched.clear()
  }

  async list(address: ProjectTodosAddress, query?: ProjectTodosQuery): Promise<ProjectTodosListResult> {
    const target = await this.targetOf(address)
    if (!target.ok) return target
    this.watch(target.project, target.file)
    const read = ProjectTodosOperations.read(target.file)
    return read.ok ? { ok: true, value: ProjectTodos.snapshotOf(target.project, target.file, this.deps.user, read.items, query) } : read
  }

  async apply(address: ProjectTodosAddress, operation: ProjectTodoOperation): Promise<ProjectTodosApplyResult> {
    const shape = ProjectTodos.operationProblemOf(operation)
    if (shape !== null) return { ok: false, code: 'invalid-operation', detail: shape }
    const target = await this.targetOf(address)
    if (!target.ok) return target
    const change: ProjectTodoOperation = operation.kind === 'add' && operation.id === undefined
      ? { ...operation, id: randomUUID().replaceAll('-', '').slice(0, 12) } : operation
    const stamp = { now: this.deps.now().toISOString(), author: this.deps.user }
    // No await from here on: one turn reads, applies and writes, so two changes of this process never interleave.
    for (let attempt = 0; attempt < ProjectTodosOperations.writeAttemptsConst; attempt++) {
      const read = ProjectTodosOperations.read(target.file)
      if (!read.ok) return read
      const step = ProjectTodos.applied(read.items, change, stamp)
      if (!step.ok) return { ok: false, code: 'invalid-operation', detail: step.detail }
      const stored = ProjectTodosOperations.replace(target.file, read.text, ProjectTodos.serialize(step.items))
      if (stored === 'changed') continue
      if (stored !== 'stored') return { ok: false, code: 'write-failed', detail: `${target.file}: ${stored}` }
      this.watch(target.project, target.file)
      this.remember(target.project, change, read.items)
      this.deps.onChanged(target.project)
      return { ok: true, value: ProjectTodos.snapshotOf(target.project, target.file, this.deps.user, step.items) }
    }
    return { ok: false, code: 'write-failed', detail: `${target.file} kept changing while it was saved; the change was not written, try it again` }
  }

  async restore(address: ProjectTodosAddress, id: string): Promise<ProjectTodosRestoreResult> {
    const target = await this.targetOf(address)
    if (!target.ok) return target
    const item = this.removed.get(target.project)?.find((candidate) => candidate.id === id)
    if (item === undefined)
      return { ok: false, code: 'not-removed', detail: `No task ${JSON.stringify(id)} was removed through Jamat since it started, or it is back already` }
    return await this.apply(address, { kind: 'restore', item })
  }

  /** A stored remove keeps the task it took out; a stored restore forgets it. */
  private remember(project: string, change: ProjectTodoOperation, before: readonly ProjectTodoItem[]): void {
    const kept = this.removed.get(project) ?? []
    if (change.kind === 'remove') {
      const item = before.find((candidate) => candidate.id === change.id)
      if (item === undefined) return
      this.removed.set(project, [...kept.filter((candidate) => candidate.id !== item.id), item].slice(-ProjectTodosOperations.removedKeptConst))
    }
    else if (change.kind === 'restore') this.removed.set(project, kept.filter((candidate) => candidate.id !== change.item.id))
  }

  private async targetOf(address: ProjectTodosAddress): Promise<ProjectTodosTarget> {
    let project: string | null
    const { session: selector, project: directory } = address
    if (selector !== undefined && directory === undefined) {
      const session = this.sessionOf(selector)
      if (!session.ok) return session
      const bound = await this.deps.sessions.catalogProject(session.sessionId)
      if (!bound.ok) return bound
      project = bound.value
    }
    else if (directory !== undefined && selector === undefined) project = await this.deps.sessions.catalogProjectOf(directory)
    else return { ok: false, code: 'invalid-target', detail: 'Name exactly one of session or project' }
    if (project === null)
      return { ok: false, code: 'no-project', detail: 'This is not in a catalog project, so it has no project todo list.' }
    return { ok: true, project, file: join(project, ...ProjectTodos.fileRelativeConst.split('/')) }
  }

  private sessionOf(selector: RemoteControlSessionSelector): ProjectTodosSession {
    const sessions = this.deps.sessions.snapshot().sessions
    let found: typeof sessions
    if (selector.kind === 'sessionId') found = sessions.filter((session) => session.sessionId === selector.sessionId)
    else if (selector.kind === 'number') found = sessions.filter((session) => session.titleParts.number === selector.number)
    else throw new Error(`Unknown session selector: ${JSON.stringify(selector satisfies never)}`)
    if (found.length === 1) return { ok: true, sessionId: found[0].sessionId, tabTitle: found[0].tabTitle }
    const name = selector.kind === 'number' ? selector.number : selector.sessionId
    if (found.length === 0) return { ok: false, code: 'session-not-found', detail: `No session ${JSON.stringify(name)}` }
    return { ok: false, code: 'session-ambiguous', detail: `Session number ${JSON.stringify(name)} is ambiguous; name it by session id` }
  }

  /** An agent, an editor or `svn update` may change the file; every window of that project reads it again. */
  private watch(project: string, file: string): void {
    if (this.watched.has(file)) return
    const listener = (current: Stats, previous: Stats): void => {
      if (current.mtimeMs !== previous.mtimeMs || current.size !== previous.size) this.deps.onChanged(project)
    }
    watchFile(file, { interval: ProjectTodosOperations.watchIntervalMsConst, persistent: false }, listener)
    this.watched.set(file, listener)
  }

  /** A missing or empty file is an empty list; a file that cannot be read whole is refused, never emptied. */
  private static read(file: string): ProjectTodosRead {
    const text = ProjectTodosOperations.textOf(file)
    if (typeof text === 'object' && text !== null) return { ok: false, code: 'file-unreadable', detail: `${file}: ${text.error}` }
    if (text === null) return { ok: true, text, items: [] }
    const parsed = ProjectTodos.parse(text.replace(/^﻿/, ''))
    if (parsed.ok) return { ok: true, text, items: parsed.items }
    if (parsed.conflict)
      return { ok: false, code: 'file-conflict', detail: `${file} has an unresolved SVN conflict. Resolve it (TortoiseSVN Edit conflicts, or keep one side) `
        + 'and mark it resolved; the list is read again by itself, and changes made meanwhile are kept and sent then.' }
    return { ok: false, code: 'file-damaged', detail: `${file}: ${parsed.detail}` }
  }

  /** The text, null for a missing file, or the reason it could not be read. */
  private static textOf(file: string): string | null | { error: string } {
    try { return readFileSync(file, 'utf8') }
    catch (error) { return ErrnoCode.of(error) === 'ENOENT' ? null : { error: ErrorText.of(error) } }
  }

  /**
   * Replaces the file only while it still holds `expected`, the text the change was applied to.
   * The check sits right before the rename, so the window an outside writer can slip into is the
   * rename itself; a moved file answers `changed` and the caller applies the change again.
   */
  private static replace(file: string, expected: string | null, text: string): 'stored' | 'changed' | string {
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
    let committed = false
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(temporary, text, { encoding: 'utf-8', mode: 0o644, flush: true })
      const current = ProjectTodosOperations.textOf(file)
      if (typeof current === 'object' && current !== null) return current.error
      if (current !== expected) return 'changed'
      WindowsHeldFile.retriedSync(() => renameSync(temporary, file))
      committed = true
      return 'stored'
    } catch (error) {
      return ErrorText.of(error)
    } finally {
      if (!committed)
        try { unlinkSync(temporary) } catch { /* never written or already gone */ }
    }
  }
}
