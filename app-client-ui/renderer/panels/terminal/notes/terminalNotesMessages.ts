import type { IpcResult } from '../../../../shared/appClientUiIpc'
import type {
  DirectoryNotesGetResult,
  DirectoryNotesImportResult,
  DirectoryNotesSaveResult,
  DirectoryNotesSnapshot,
} from '../../../../shared/directoryNotes'
import type { TerminalNotesSaveOutcome } from './terminalNotesSaveQueue'

type ImportRefused = Extract<DirectoryNotesImportResult, { kind: 'refused' }>
type ImportPartial = Extract<DirectoryNotesImportResult, { kind: 'partial' }>

/** Every sentence the Notes tab shows, and the unwrapping of the answers they come from. */
export class TerminalNotesMessages {
  static readonly emptyConst = 'Nothing in the prompt to import'
  static readonly pasteRefusedConst = 'The terminal is not accepting input'

  static saveOutcomeOf(answer: IpcResult<DirectoryNotesSaveResult>): TerminalNotesSaveOutcome {
    if (!answer.ok) return { ok: false, detail: `Notes were not saved: ${answer.error}` }
    const result = answer.value
    if (result.ok) return { ok: true }
    else if (result.code === 'unknown-session')
      return { ok: false, detail: `Notes were not saved: the session is no longer known (${result.detail})` }
    else if (result.code === 'config-latched')
      return { ok: false, detail: `Notes were not saved: config.json could not be read, so nothing is written to it (${result.detail})` }
    else if (result.code === 'section-damaged')
      return { ok: false, detail: `Notes were not saved: the directoryNotes section of config.json is damaged (${result.detail})` }
    else if (result.code === 'invalid-section')
      return { ok: false, detail: `Notes were not saved: ${result.detail}` }
    else throw new Error(`Unknown directoryNotes save result: ${JSON.stringify(result)}`)
  }

  static snapshotOf(
    answer: IpcResult<DirectoryNotesGetResult>,
  ): { ok: true; value: DirectoryNotesSnapshot } | { ok: false; detail: string } {
    if (!answer.ok) return { ok: false, detail: `Notes could not be read: ${answer.error}` }
    const result = answer.value
    if (result.ok) return result
    else if (result.code === 'unknown-session')
      return { ok: false, detail: `Notes could not be read: the session is no longer known (${result.detail})` }
    else if (result.code === 'config-latched')
      return { ok: false, detail: `Notes could not be read: config.json could not be read (${result.detail})` }
    else if (result.code === 'section-damaged')
      return { ok: false, detail: `Notes could not be read: the directoryNotes section of config.json is damaged (${result.detail})` }
    else throw new Error(`Unknown directoryNotes read result: ${JSON.stringify(result)}`)
  }

  static importStopped(detail: string): string {
    return `Import stopped, the notes were not saved first: ${detail}`
  }

  /** The channel failed, so whether a note was stored is unknown; the caller reads the notes again. */
  static importFailed(error: string): string {
    return `Import failed: ${error}`
  }

  static partial(result: ImportPartial): string {
    const note = `#${result.index + 1}`
    if (result.reason === 'not-erased') return `Saved as note ${note}, but the prompt was not erased: ${result.detail}`
    else if (result.reason === 'text-remains') return `Saved as note ${note}, but text is still in the prompt: ${result.detail}`
    else throw new Error(`Unknown partial import: ${JSON.stringify(result)}`)
  }

  static refusal(result: ImportRefused): string {
    const reason = result.reason
    if (reason === 'unknown-session') return 'Import refused: the session is no longer known'
    else if (reason === 'not-live') return 'Import refused: the session is not running'
    else if (reason === 'not-agent') return 'Import refused: only a Claude or Codex prompt can be imported'
    else if (reason === 'unreadable') return 'Import refused: the screen cannot be read; a Host older than this build needs a restart'
    else if (reason === 'dialog') return 'Import refused: the agent is showing a dialog'
    else if (reason === 'no-prompt') return 'Import refused: no prompt box was recognized on screen'
    else if (reason === 'too-tall') return 'Import refused: the prompt is taller than the terminal window'
    else if (reason === 'placeholder') return 'Import refused: the prompt holds a collapsed paste or an image'
    else if (reason === 'in-flight') return 'Import refused: another delivery to this session is still running'
    else if (reason === 'read-only') return 'Import refused: this window has the terminal read-only'
    else if (reason === 'storage') return `Import refused, nothing was erased: ${result.detail}`
    else if (reason === 'unavailable') return `Import refused: the terminal is not reachable (${result.detail})`
    else if (reason === 'failed') return `Import failed: ${result.detail}`
    else throw new Error(`Unknown import refusal: ${JSON.stringify(result)}`)
  }
}
