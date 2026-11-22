import { ProjectTodos, type ProjectTodoItem, type ProjectTodoOperation, type ProjectTodosStamp } from '../../shared/projectTodos'

/**
 * A view's changes on their way to the orchestrator. `confirmed` is the list the orchestrator last
 * answered; what is shown is that list with every waiting change applied, so typing shows at once.
 * Only `queue[0]` is ever in flight, and only while `sending`.
 */
export interface ProjectTodosQueueState {
  confirmed: readonly ProjectTodoItem[]
  queue: readonly ProjectTodoOperation[]
  sending: boolean
}

export class ProjectTodosQueue {
  static of(confirmed: readonly ProjectTodoItem[]): ProjectTodosQueueState {
    return { confirmed, queue: [], sending: false }
  }

  static shown(state: ProjectTodosQueueState, stamp: ProjectTodosStamp): readonly ProjectTodoItem[] {
    return state.queue.reduce((items, operation) => {
      const step = ProjectTodos.applied(items, operation, stamp)
      return step.ok ? step.items : items
    }, state.confirmed)
  }

  /**
   * Text edits of one task fold into the waiting change of that task: into an unsent add, which then
   * carries the latest text, or into the unsent edit. A change in flight is never touched.
   */
  static enqueued(state: ProjectTodosQueueState, operation: ProjectTodoOperation): ProjectTodosQueueState {
    if (operation.kind === 'edit') {
      const last = state.queue.length - 1
      const held = state.queue[last]
      const unsent = last > 0 || (last === 0 && !state.sending)
      if (unsent && held !== undefined && (held.kind === 'edit' || held.kind === 'add') && held.id === operation.id) {
        const category = operation.category ?? held.category
        const comment = operation.comment ?? held.comment
        const color = operation.color ?? held.color
        const folded: ProjectTodoOperation = held.kind === 'add'
          ? { ...held, title: operation.title ?? held.title, category, comment, color }
          : { ...held, title: operation.title ?? held.title, category, comment, color }
        return { ...state, queue: [...state.queue.slice(0, last), folded] }
      }
    }
    return { ...state, queue: [...state.queue, operation] }
  }

  /** The head goes out; null when nothing waits or something is already out. */
  static sent(state: ProjectTodosQueueState): { state: ProjectTodosQueueState; operation: ProjectTodoOperation } | null {
    const head = state.queue[0]
    if (state.sending || head === undefined) return null
    return { state: { ...state, sending: true }, operation: head }
  }

  /** The orchestrator stored the head and answered the list as it is on disk now. */
  static stored(state: ProjectTodosQueueState, items: readonly ProjectTodoItem[]): ProjectTodosQueueState {
    return { confirmed: items, queue: state.queue.slice(1), sending: false }
  }

  /** The orchestrator refused the head; it is dropped, and the view reads the list again. */
  static refused(state: ProjectTodosQueueState): ProjectTodosQueueState {
    return { ...state, queue: state.queue.slice(1), sending: false }
  }

  /** The head never arrived, or the file could not take it now; it stays first for a retry. */
  static failed(state: ProjectTodosQueueState): ProjectTodosQueueState {
    return { ...state, sending: false }
  }

  /** A fresh reading is adopted only while nothing waits, or it would undo what is shown. */
  static read(state: ProjectTodosQueueState, items: readonly ProjectTodoItem[]): ProjectTodosQueueState {
    return state.queue.length === 0 && !state.sending ? { ...state, confirmed: items } : state
  }

  static idle(state: ProjectTodosQueueState): boolean {
    return state.queue.length === 0 && !state.sending
  }
}
