import { useEffect, useMemo, useReducer, useRef } from 'react'

import { PathText } from '../../../../shared/pathText'
import { TerminalNotesMessages } from './terminalNotesMessages'
import { TerminalNotesSaveQueue } from './terminalNotesSaveQueue'
import { TerminalNotesState } from './terminalNotesState'
import type { TerminalNoteEntry, TerminalNotesPhase, TerminalNotesView } from './terminalNotesState'

export interface TerminalNotesModel {
  phase: TerminalNotesPhase
  directory: string | null
  entries: readonly TerminalNoteEntry[]
  error: string | null
  notice: string | null
  importing: boolean
  focusId: string | null
  add(): void
  update(id: string, text: string): void
  removeOrClear(id: string): void
  toggleSticky(id: string): void
  toggleLarge(id: string): void
  commitNow(): void
  paste(id: string): void
  importPrompt(): Promise<void>
  retry(): void
}

export interface TerminalNotesOptions {
  sessionId: string
  /** The tab is on screen. The first true triggers the one lazy load. */
  enabled: boolean
  /** Writes the note into this panel's terminal; false when the terminal refused it. */
  paste(text: string): boolean
  /** The prompt was erased by main, which this window's draft count never saw. */
  onTaken(): void
}

/**
 * Everything one session's notes hold while a panel shows them. A new session gets a new scope, so
 * an answer or a save that belongs to the previous one can never land in the editor of the next.
 */
class TerminalNotesScope {
  readonly sessionId: string
  private readonly rerender: () => void
  private readonly queue: TerminalNotesSaveQueue
  private current: TerminalNotesView
  /** Bumped by every local edit and every adopted import: a read that left before it is older. */
  private revision = 0
  private reads = 0
  private alive = true

  constructor(sessionId: string, rerender: () => void) {
    this.sessionId = sessionId
    this.rerender = rerender
    this.current = TerminalNotesState.initial()
    this.queue = new TerminalNotesSaveQueue(
      async (notes) => TerminalNotesMessages.saveOutcomeOf(
        await window.appClient.directoryNotes.save(sessionId, notes)),
      (outcome) => this.publish({ ...this.current, error: outcome.ok ? null : outcome.detail }),
    )
  }

  get view(): TerminalNotesView {
    return this.current
  }

  open(): void {
    if (this.current.phase === 'idle') void this.load()
  }

  /** Another window, or this one, stored a directory's notes. An editor with unsaved text keeps it. */
  changed(directory: string): void {
    const current = this.current
    if (current.directory === null || !PathText.equal(directory, current.directory)) return
    if (this.queue.dirty() || current.importing) return
    void this.load()
  }

  add(): void {
    this.edit((view) => TerminalNotesState.added(view))
  }

  update(id: string, text: string): void {
    this.edit((view) => TerminalNotesState.updated(view, id, text))
  }

  removeOrClear(id: string): void {
    this.edit((view) => TerminalNotesState.removedOrCleared(view, id))
  }

  toggle(id: string, flag: 'large' | 'sticky'): void {
    this.edit((view) => TerminalNotesState.toggled(view, id, flag))
  }

  commitNow(): void {
    void this.queue.flush()
  }

  retry(): void {
    const phase = this.current.phase
    if (phase === 'failed') void this.load()
    else if (phase === 'ready') void this.queue.flush()
    else if (phase === 'idle' || phase === 'loading') return
    else throw new Error(`Unknown notes phase: ${JSON.stringify(phase)}`)
  }

  paste(id: string, paste: (text: string) => boolean): void {
    if (!this.editable()) return
    const entry = this.current.entries.find((candidate) => candidate.id === id)
    if (entry === undefined || entry.text.trim() === '') return
    if (!paste(entry.text)) {
      this.publish({ ...this.current, notice: TerminalNotesMessages.pasteRefusedConst })
      return
    }
    // Changed only after the terminal accepted the write; a sticky note stays as it is.
    this.commit(TerminalNotesState.pasted(this.current, id))
  }

  /**
   * Locks the editors first, so a second click and any typing wait, then sends the pending edit:
   * main appends to what is stored, and an unsaved edit would otherwise be overwritten by the adopted
   * list.
   */
  async importPrompt(onTaken: () => void): Promise<void> {
    if (!this.editable()) return
    this.publish({ ...this.current, importing: true, notice: null })
    try {
      const flushed = await this.queue.flush()
      if (!this.alive) return
      if (!flushed.ok) {
        this.publish({ ...this.current, notice: TerminalNotesMessages.importStopped(flushed.detail) })
        return
      }
      const answer = await window.appClient.directoryNotes.importPrompt(this.sessionId)
      if (!this.alive) return
      if (!answer.ok) {
        this.publish({ ...this.current, notice: TerminalNotesMessages.importFailed(answer.error) })
        await this.load()
        return
      }
      const result = answer.value
      if (result.kind === 'taken') {
        this.adopt(TerminalNotesState.adopted(this.current, result.notes, result.index, null))
        onTaken()
      } else if (result.kind === 'partial')
        this.adopt(TerminalNotesState.adopted(
          this.current, result.notes, result.index, TerminalNotesMessages.partial(result)))
      else if (result.kind === 'empty')
        this.publish({ ...this.current, notice: TerminalNotesMessages.emptyConst })
      else if (result.kind === 'refused')
        this.publish({ ...this.current, notice: TerminalNotesMessages.refusal(result) })
      else
        throw new Error(`Unknown import result: ${JSON.stringify(result)}`)
    } finally {
      if (this.alive) this.publish({ ...this.current, importing: false })
    }
  }

  dispose(): void {
    this.alive = false
    this.queue.dispose()
  }

  private editable(): boolean {
    return this.current.phase === 'ready' && !this.current.importing
  }

  private edit(change: (view: TerminalNotesView) => TerminalNotesView): void {
    if (!this.editable()) return
    this.commit(change(this.current))
  }

  private commit(next: TerminalNotesView): void {
    this.revision += 1
    this.publish(next)
    this.queue.schedule(TerminalNotesState.stored(next.entries))
  }

  /** What main stored is already saved, so nothing is scheduled; a read still out is now older. */
  private adopt(next: TerminalNotesView): void {
    this.revision += 1
    this.publish(next)
  }

  private async load(): Promise<void> {
    const revision = this.revision
    const read = ++this.reads
    this.publish(TerminalNotesState.loading(this.current))
    const answer = await window.appClient.directoryNotes.get(this.sessionId)
    // An edit made while the read was out wins, and so does a later read.
    if (!this.alive || revision !== this.revision || read !== this.reads) return
    const snapshot = TerminalNotesMessages.snapshotOf(answer)
    this.publish(snapshot.ok
      ? TerminalNotesState.loaded(this.current, snapshot.value)
      : TerminalNotesState.failed(this.current, snapshot.detail))
  }

  private publish(next: TerminalNotesView): void {
    this.current = next
    if (this.alive) this.rerender()
  }
}

/**
 * The terminal's Notes tab, alive for the whole life of the panel: switching to another tab keeps
 * the editor and its queue, and the notes are read only the first time the tab is shown.
 */
export function useTerminalNotes(options: TerminalNotesOptions): TerminalNotesModel {
  const [, rerender] = useReducer((count: number) => count + 1, 0)
  const latest = useRef(options)
  latest.current = options
  const scopeRef = useRef<TerminalNotesScope | null>(null)
  if (scopeRef.current === null || scopeRef.current.sessionId !== options.sessionId)
    scopeRef.current = new TerminalNotesScope(options.sessionId, rerender)
  const scope = scopeRef.current

  // A closing panel, or a switch to another session, still sends the last edit under its session.
  useEffect(() => () => scope.dispose(), [scope])

  useEffect(() => {
    if (options.enabled) scope.open()
  }, [options.enabled, scope])

  useEffect(() => window.appClient.onDirectoryNotesChanged((directory) => scope.changed(directory)), [scope])

  const actions = useMemo(() => ({
    add: () => scope.add(),
    update: (id: string, text: string) => scope.update(id, text),
    removeOrClear: (id: string) => scope.removeOrClear(id),
    toggleSticky: (id: string) => scope.toggle(id, 'sticky'),
    toggleLarge: (id: string) => scope.toggle(id, 'large'),
    commitNow: () => scope.commitNow(),
    paste: (id: string) => scope.paste(id, (text) => latest.current.paste(text)),
    importPrompt: () => scope.importPrompt(() => latest.current.onTaken()),
    retry: () => scope.retry(),
  }), [scope])

  const view = scope.view
  return {
    phase: view.phase,
    directory: view.directory,
    entries: view.entries,
    error: view.error,
    notice: view.notice,
    importing: view.importing,
    focusId: view.focusId,
    ...actions,
  }
}
