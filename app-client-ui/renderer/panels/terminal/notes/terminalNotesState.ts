import type { DirectoryNote, DirectoryNotesSnapshot } from '../../../../shared/directoryNotes'

export interface TerminalNoteEntry {
  id: string
  text: string
  large: boolean
  sticky: boolean
}

export type TerminalNotesPhase = 'idle' | 'loading' | 'ready' | 'failed'

export interface TerminalNotesView {
  phase: TerminalNotesPhase
  directory: string | null
  entries: readonly TerminalNoteEntry[]
  /** A failed load while `failed`, otherwise the last failed save; cleared by the next good one. */
  error: string | null
  notice: string | null
  importing: boolean
  /** The textarea to focus. Every transition that does not ask for focus sets it back to null. */
  focusId: string | null
  nextId: number
}

/** The Notes tab's editor as pure transitions; the hook owns when they run and what gets saved. */
export class TerminalNotesState {
  static initial(): TerminalNotesView {
    return {
      phase: 'idle',
      directory: null,
      entries: [],
      error: null,
      notice: null,
      importing: false,
      focusId: null,
      nextId: 1,
    }
  }

  /** A list already on screen stays while it is read again; only a first read shows loading. */
  static loading(view: TerminalNotesView): TerminalNotesView {
    if (view.phase === 'ready' || view.phase === 'loading') return view
    else if (view.phase === 'idle' || view.phase === 'failed') return { ...view, phase: 'loading', error: null }
    else throw new Error(`Unknown notes phase: ${JSON.stringify(view.phase)}`)
  }

  /**
   * Ids follow the index, so a read that changed nothing keeps every textarea, and the one being
   * typed in keeps its focus. A save error stays: a read does not prove the editor was saved.
   */
  static loaded(view: TerminalNotesView, snapshot: DirectoryNotesSnapshot): TerminalNotesView {
    const next = TerminalNotesState.entriesOf(view, snapshot.notes)
    return {
      ...view,
      phase: 'ready',
      directory: snapshot.directory,
      entries: next.entries,
      error: view.phase === 'ready' ? view.error : null,
      focusId: null,
      nextId: next.nextId,
    }
  }

  static failed(view: TerminalNotesView, detail: string): TerminalNotesView {
    return { ...view, phase: 'failed', entries: [], error: detail, focusId: null }
  }

  /** The list main stored for an import, with the imported note focused. */
  static adopted(
    view: TerminalNotesView,
    notes: readonly DirectoryNote[],
    index: number,
    notice: string | null,
  ): TerminalNotesView {
    const next = TerminalNotesState.entriesOf(view, notes)
    return {
      ...view,
      phase: 'ready',
      entries: next.entries,
      notice,
      focusId: next.entries[index]?.id ?? null,
      nextId: next.nextId,
    }
  }

  static added(view: TerminalNotesView): TerminalNotesView {
    const entry = TerminalNotesState.entryOf(TerminalNotesState.idOf(view.nextId), { text: '' })
    return { ...view, entries: [...view.entries, entry], focusId: entry.id, nextId: view.nextId + 1 }
  }

  static updated(view: TerminalNotesView, id: string, text: string): TerminalNotesView {
    return TerminalNotesState.mapped(view, id, (entry) => ({ ...entry, text }))
  }

  /** The last note is never removed, only emptied, and it keeps its flags. */
  static removedOrCleared(view: TerminalNotesView, id: string): TerminalNotesView {
    if (view.entries.length > 1)
      return { ...view, entries: view.entries.filter((entry) => entry.id !== id), focusId: null }
    return TerminalNotesState.updated(view, id, '')
  }

  static toggled(view: TerminalNotesView, id: string, flag: 'large' | 'sticky'): TerminalNotesView {
    if (flag === 'large') return TerminalNotesState.mapped(view, id, (entry) => ({ ...entry, large: !entry.large }))
    else if (flag === 'sticky') return TerminalNotesState.mapped(view, id, (entry) => ({ ...entry, sticky: !entry.sticky }))
    else throw new Error(`Unknown note flag: ${JSON.stringify(flag)}`)
  }

  /** After the terminal accepted a note: a sticky one stays, any other goes. */
  static pasted(view: TerminalNotesView, id: string): TerminalNotesView {
    const entry = view.entries.find((candidate) => candidate.id === id)
    if (entry === undefined || entry.sticky) return { ...view, notice: null }
    return { ...TerminalNotesState.removedOrCleared(view, id), notice: null }
  }

  /** What is written: flags only when true, like the section stores them. */
  static stored(entries: readonly TerminalNoteEntry[]): DirectoryNote[] {
    return entries.map((entry) => {
      const note: DirectoryNote = { text: entry.text }
      if (entry.large) note.large = true
      if (entry.sticky) note.sticky = true
      return note
    })
  }

  private static mapped(
    view: TerminalNotesView,
    id: string,
    change: (entry: TerminalNoteEntry) => TerminalNoteEntry,
  ): TerminalNotesView {
    return {
      ...view,
      entries: view.entries.map((entry) => entry.id === id ? change(entry) : entry),
      focusId: null,
    }
  }

  private static entriesOf(
    view: TerminalNotesView,
    notes: readonly DirectoryNote[],
  ): { entries: TerminalNoteEntry[]; nextId: number } {
    let nextId = view.nextId
    const entries = notes.map((note, index) => {
      const kept = view.entries[index]
      if (kept !== undefined) return TerminalNotesState.entryOf(kept.id, note)
      const entry = TerminalNotesState.entryOf(TerminalNotesState.idOf(nextId), note)
      nextId += 1
      return entry
    })
    return { entries, nextId }
  }

  private static idOf(sequence: number): string {
    return `note-${sequence}`
  }

  private static entryOf(id: string, note: DirectoryNote): TerminalNoteEntry {
    return { id, text: note.text, large: note.large === true, sticky: note.sticky === true }
  }
}
