import type { ProjectTodoColor, ProjectTodoItem, ProjectTodoOperation } from '../../shared/projectTodos'
import type { ProjectTodosApplyRefusal, ProjectTodosPorts } from './projectTodosPorts'
import { ProjectTodosQueue, type ProjectTodosQueueState } from './projectTodosQueue'

export interface ProjectTodosRemoved {
  item: ProjectTodoItem
}

export interface ProjectTodosView {
  phase: 'loading' | 'ready' | 'failed' | 'unavailable'
  project: string | null
  file: string | null
  /** The operating-system user a new task records as its author. */
  user: string
  items: readonly ProjectTodoItem[]
  /** The last refused or lost change, or why the list cannot be read. */
  error: string | null
  saving: boolean
  removed: ProjectTodosRemoved | null
}

export interface ProjectTodosText {
  title: string
  category: string
  comment: string
  color: ProjectTodoColor | ''
}

/**
 * One view's todo list: what it shows, the changes on their way and the reading again when the list
 * moved elsewhere. Text edits wait half a second so typing sends one change; every other change and
 * a blur send at once. A change the file cannot take now (an SVN conflict, a failed write) stays
 * first and goes again when the file changes or on Retry; a change the list refuses is dropped. A
 * disposed controller still sends what waits, and shows nothing more.
 */
export class ProjectTodosController {
  private static readonly editDelayMsConst = 500
  private static readonly undoMsConst = 8_000
  private readonly sessionId: string
  private readonly ports: ProjectTodosPorts
  private readonly listeners = new Set<() => void>()
  private queue: ProjectTodosQueueState = ProjectTodosQueue.of([])
  private phase: ProjectTodosView['phase'] = 'loading'
  private project: string | null = null
  private file: string | null = null
  private user = ''
  private error: string | null = null
  private removed: ProjectTodosRemoved | null = null
  private reading = false
  private disposed = false
  private editTimer: ReturnType<typeof setTimeout> | null = null
  private undoTimer: ReturnType<typeof setTimeout> | null = null
  private unsubscribe: (() => void) | null = null
  private current: ProjectTodosView

  constructor(sessionId: string, ports: ProjectTodosPorts) {
    this.sessionId = sessionId
    this.ports = ports
    this.current = this.composed()
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  readonly view = (): ProjectTodosView => this.current

  start(): void {
    this.disposed = false
    this.unsubscribe?.()
    this.unsubscribe = this.ports.subscribe((project) => { if (project === this.project) void this.moved() })
    void this.load()
  }

  dispose(): void {
    this.disposed = true
    this.unsubscribe?.()
    this.unsubscribe = null
    if (this.undoTimer !== null) clearTimeout(this.undoTimer)
    this.flush()
  }

  add(title: string, category: string, comment = '', color: ProjectTodoColor | '' = ''): void {
    const text = title.trim()
    if (text === '') return
    this.enqueue({ kind: 'add', id: ProjectTodosController.newId(), title: text, category: category.trim(),
      comment: comment.trim() === '' ? '' : comment, ...(color === '' ? {} : { color }) })
  }

  edit(id: string, text: ProjectTodosText): void {
    this.enqueue({ kind: 'edit', id, ...text })
  }

  toggle(id: string): void {
    const item = this.current.items.find((candidate) => candidate.id === id)
    if (item !== undefined) this.enqueue({ kind: 'toggle', id, done: !item.done })
  }

  remove(id: string): void {
    const item = this.current.items.find((candidate) => candidate.id === id)
    if (item === undefined) return
    this.removed = { item }
    if (this.undoTimer !== null) clearTimeout(this.undoTimer)
    this.undoTimer = setTimeout(() => { this.removed = null; this.undoTimer = null; this.emit() }, ProjectTodosController.undoMsConst)
    this.enqueue({ kind: 'remove', id })
  }

  undo(): void {
    const removed = this.removed
    if (removed === null) return
    this.removed = null
    if (this.undoTimer !== null) clearTimeout(this.undoTimer)
    this.undoTimer = null
    this.enqueue({ kind: 'restore', item: removed.item })
  }

  /** A blur: a waiting text edit goes now. */
  flush(): void {
    if (this.editTimer !== null) clearTimeout(this.editTimer)
    this.editTimer = null
    void this.drain()
  }

  retry(): void {
    if (ProjectTodosQueue.idle(this.queue)) void this.load()
    else void this.drain()
  }

  private enqueue(operation: ProjectTodoOperation): void {
    this.queue = ProjectTodosQueue.enqueued(this.queue, operation)
    this.emit()
    if (operation.kind === 'edit') {
      if (this.editTimer !== null) clearTimeout(this.editTimer)
      this.editTimer = setTimeout(() => this.flush(), ProjectTodosController.editDelayMsConst)
    }
    else this.flush()
  }

  private async load(): Promise<void> {
    this.reading = true
    const answer = await this.ports.list(this.sessionId)
    this.reading = false
    if (!answer.ok) {
      this.phase = 'failed'
      this.error = `The todo list could not be read: ${answer.error}`
    }
    else if (answer.value.ok) {
      this.adopt(answer.value.value)
      this.queue = ProjectTodosQueue.read(this.queue, answer.value.value.items)
      this.phase = 'ready'
      this.error = null
    }
    else {
      this.phase = answer.value.code === 'no-project' ? 'unavailable' : 'failed'
      this.error = answer.value.detail
    }
    this.emit()
  }

  /**
   * The file moved elsewhere. An idle view reads it again; a view whose first change waits for the
   * file (a conflict that is now resolved) sends it, and its answer is the fresh list.
   */
  private async moved(): Promise<void> {
    if (this.disposed) return
    if (!ProjectTodosQueue.idle(this.queue)) await this.drain()
    else await this.reread()
  }

  /** The changes of this view answer the list themselves; a reading is for a list that moved elsewhere. */
  private async reread(): Promise<void> {
    if (this.reading || !ProjectTodosQueue.idle(this.queue) || this.disposed) return
    await this.load()
  }

  private adopt(snapshot: { project: string; file: string; user: string }): void {
    this.project = snapshot.project
    this.file = snapshot.file
    this.user = snapshot.user
  }

  private async drain(): Promise<void> {
    const next = ProjectTodosQueue.sent(this.queue)
    if (next === null) return
    this.queue = next.state
    this.emit()
    const answer = await this.ports.apply(this.sessionId, next.operation)
    if (!answer.ok) {
      this.queue = ProjectTodosQueue.failed(this.queue)
      this.error = `The change was not saved: ${answer.error}`
      this.emit()
      return
    }
    if (answer.value.ok) {
      this.queue = ProjectTodosQueue.stored(this.queue, answer.value.value.items)
      this.adopt(answer.value.value)
      this.phase = 'ready'
      this.error = null
    }
    else if (ProjectTodosController.waitsForFile(answer.value.code)) {
      this.queue = ProjectTodosQueue.failed(this.queue)
      this.error = answer.value.detail
      this.emit()
      return
    }
    else {
      this.queue = ProjectTodosQueue.refused(this.queue)
      this.error = answer.value.detail
    }
    this.emit()
    if (!ProjectTodosQueue.idle(this.queue)) await this.drain()
    else if (!answer.value.ok) await this.reread()
  }

  private emit(): void {
    if (this.disposed) return
    this.current = this.composed()
    for (const listener of this.listeners) listener()
  }

  private composed(): ProjectTodosView {
    return {
      phase: this.phase,
      project: this.project,
      file: this.file,
      user: this.user,
      items: ProjectTodosQueue.shown(this.queue, { now: new Date().toISOString(), author: this.user }),
      error: this.error,
      saving: !ProjectTodosQueue.idle(this.queue),
      removed: this.removed,
    }
  }

  /** The file cannot take a change now, but will: the change is kept. Every other refusal drops it. */
  private static waitsForFile(code: ProjectTodosApplyRefusal): boolean {
    if (code === 'file-conflict' || code === 'file-damaged' || code === 'file-unreadable' || code === 'write-failed') return true
    else if (code === 'invalid-operation' || code === 'invalid-target' || code === 'session-not-found' || code === 'session-ambiguous'
      || code === 'unknown-session' || code === 'no-project') return false
    else throw new Error(`Unknown todo refusal: ${JSON.stringify(code satisfies never)}`)
  }

  private static newId(): string {
    return crypto.randomUUID().replaceAll('-', '').slice(0, 12)
  }
}
