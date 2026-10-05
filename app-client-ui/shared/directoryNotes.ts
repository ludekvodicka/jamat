import { JsonShape } from './jsonShape'
import { PathText } from './pathText'

export interface DirectoryNote {
  text: string
  /** Written only when true, so a hand-edited config.json stays short. */
  large?: boolean
  sticky?: boolean
}

/** The `directoryNotes` section: working directory -> its notes, in the order they are shown. */
export type DirectoryNotesValue = Readonly<Record<string, readonly DirectoryNote[]>>

export interface DirectoryNotesSnapshot {
  directory: string
  notes: readonly DirectoryNote[]
}

export type DirectoryNotesGetResult =
  | { ok: true; value: DirectoryNotesSnapshot }
  | { ok: false; code: 'unknown-session' | 'config-latched' | 'section-damaged'; detail: string }

export type DirectoryNotesSaveResult =
  | { ok: true }
  | {
    ok: false
    code: 'unknown-session' | 'config-latched' | 'section-damaged' | 'invalid-section'
    detail: string
  }

export type DirectoryNotesImportRefusal =
  | 'unknown-session'
  | 'not-live'
  | 'not-agent'
  | 'unreadable'
  | 'dialog'
  | 'no-prompt'
  | 'too-tall'
  | 'placeholder'
  | 'in-flight'
  | 'read-only'
  | 'storage'
  | 'unavailable'
  | 'failed'

/**
 * `taken` and `partial` carry the directory's stored notes and where the prompt went, so the panel
 * adopts what main wrote instead of reading it again. `partial` means the note holds the whole
 * prompt and the prompt still holds some or all of it.
 */
export type DirectoryNotesImportResult =
  | { kind: 'taken'; notes: readonly DirectoryNote[]; index: number }
  | {
    kind: 'partial'
    notes: readonly DirectoryNote[]
    index: number
    reason: 'not-erased' | 'text-remains'
    detail: string
  }
  | { kind: 'empty' }
  | { kind: 'refused'; reason: DirectoryNotesImportRefusal; detail: string }

/**
 * The notes of each working directory, read and written by main and shown by the terminal's Notes
 * tab. Here rather than in the main process because the renderer holds the same limits in its UI.
 */
export class DirectoryNotes {
  static readonly notesMaxConst = 50
  static readonly noteCharactersMaxConst = 20_000

  static defaultNotes(): readonly DirectoryNote[] {
    return [{ text: '' }]
  }

  /**
   * Total, like every section coercion. A bare string is a note a person typed by hand. What cannot
   * be read is reported and left out of the reading; `damaged` keeps a save from writing that
   * reading back over it.
   */
  static coerce(value: unknown, report: (message: string) => void): DirectoryNotesValue {
    if (value === undefined) return {}
    const record = JsonShape.record(value)
    if (record === null) {
      report('The directoryNotes section of config.json is not an object; reading it as no notes')
      return {}
    }
    const result: Record<string, readonly DirectoryNote[]> = {}
    for (const [directory, list] of Object.entries(record)) {
      if (!Array.isArray(list)) {
        report(`The directoryNotes of ${JSON.stringify(directory)} in config.json are not a list; `
          + 'reading them as no notes')
        continue
      }
      const notes: DirectoryNote[] = []
      for (const entry of list) {
        const note = DirectoryNotes.noteOf(entry)
        if (note === null)
          report(`The directoryNotes of ${JSON.stringify(directory)} in config.json hold an unusable `
            + `note (${JSON.stringify(entry)}); leaving it out`)
        else notes.push(note)
      }
      result[directory] = notes
    }
    return result
  }

  /** Shape only: a list that is merely over the limits is still something this build can read. */
  static damaged(value: unknown): boolean {
    if (value === undefined) return false
    const record = JsonShape.record(value)
    if (record === null) return true
    for (const list of Object.values(record)) {
      if (!Array.isArray(list)) return true
      if (list.some((entry) => DirectoryNotes.noteOf(entry) === null)) return true
    }
    return false
  }

  /** The section's `validate`. Limits are not checked here, see `problemOf`. */
  static shapeProblemOf(value: DirectoryNotesValue): string | null {
    if (!JsonShape.isRecord(value)) return 'directoryNotes must be an object'
    for (const [directory, list] of Object.entries(value)) {
      if (!Array.isArray(list)) return `directoryNotes of ${JSON.stringify(directory)} must be a list`
      if (!list.every((entry) => DirectoryNotes.isNote(entry)))
        return `every note of ${JSON.stringify(directory)} needs a text and boolean flags`
    }
    return null
  }

  /**
   * The limits of the one set a window offers. Checked at the IPC boundary rather than by the
   * section's `validate`, which sees every directory: a note another directory grew by hand would
   * otherwise refuse every save.
   */
  static problemOf(notes: readonly DirectoryNote[]): string | null {
    if (!Array.isArray(notes)) return 'notes must be a list'
    if (notes.length === 0) return 'a directory keeps at least one note'
    if (notes.length > DirectoryNotes.notesMaxConst)
      return `a directory keeps at most ${DirectoryNotes.notesMaxConst} notes`
    for (const note of notes) {
      if (!DirectoryNotes.isNote(note)) return 'every note needs a text and boolean flags'
      if (note.text.length > DirectoryNotes.noteCharactersMaxConst)
        return `a note holds at most ${DirectoryNotes.noteCharactersMaxConst} characters`
    }
    return null
  }

  /** Never an empty list: a directory nobody wrote for shows one empty note. */
  static at(value: DirectoryNotesValue, directory: string): readonly DirectoryNote[] {
    const key = Object.keys(value).find((candidate) => PathText.equal(candidate, directory))
    const notes = key === undefined ? undefined : value[key]
    return notes === undefined || notes.length === 0 ? DirectoryNotes.defaultNotes() : notes
  }

  /**
   * Every spelling of the directory gives way to one key, in the place of the first. The default set
   * removes the key, so a directory somebody only looked at leaves nothing behind.
   */
  static withDirectory(
    value: DirectoryNotesValue,
    directory: string,
    notes: readonly DirectoryNote[],
  ): DirectoryNotesValue {
    const stored = notes.map((note) => DirectoryNotes.storedOf(note))
    const keep = !DirectoryNotes.isDefault(stored)
    const result: Record<string, readonly DirectoryNote[]> = {}
    let placed = false
    for (const [key, list] of Object.entries(value)) {
      if (!PathText.equal(key, directory)) result[key] = list
      else if (!placed) {
        placed = true
        if (keep) result[directory] = stored
      }
    }
    if (!placed && keep) result[directory] = stored
    return result
  }

  /** The one empty note takes the text and keeps its flags; any other set gets a new last note. */
  static withImported(
    value: DirectoryNotesValue,
    directory: string,
    text: string,
  ): { value: DirectoryNotesValue; index: number } {
    const current = DirectoryNotes.at(value, directory)
    const only = current.length === 1 ? current[0] : undefined
    if (only !== undefined && only.text === '')
      return { value: DirectoryNotes.withDirectory(value, directory, [{ ...only, text }]), index: 0 }
    return {
      value: DirectoryNotes.withDirectory(value, directory, [...current, { text }]),
      index: current.length,
    }
  }

  private static noteOf(entry: unknown): DirectoryNote | null {
    if (typeof entry === 'string') return { text: entry }
    if (!DirectoryNotes.isNote(entry)) return null
    return DirectoryNotes.storedOf(entry)
  }

  private static isNote(entry: unknown): entry is DirectoryNote {
    const record = JsonShape.record(entry)
    return record !== null
      && typeof record['text'] === 'string'
      && (record['large'] === undefined || typeof record['large'] === 'boolean')
      && (record['sticky'] === undefined || typeof record['sticky'] === 'boolean')
  }

  private static storedOf(note: DirectoryNote): DirectoryNote {
    const stored: DirectoryNote = { text: note.text }
    if (note.large === true) stored.large = true
    if (note.sticky === true) stored.sticky = true
    return stored
  }

  private static isDefault(notes: readonly DirectoryNote[]): boolean {
    const only = notes.length === 1 ? notes[0] : undefined
    return only !== undefined && only.text === '' && only.large !== true && only.sticky !== true
  }
}
