import type { IpcResult } from '../../../../shared/appClientUiIpc'
import type { DirectoryNote, DirectoryNotesGetResult, DirectoryNotesSaveResult, DirectoryNotesImportResult } from '../../../../shared/directoryNotes'
import { AppControl } from '../../../ipc/appControl'

export interface TerminalNotesPorts {
  get(sessionId: string): Promise<IpcResult<DirectoryNotesGetResult>>
  save(sessionId: string, notes: readonly DirectoryNote[]): Promise<IpcResult<DirectoryNotesSaveResult>>
  importPrompt(sessionId: string): Promise<IpcResult<DirectoryNotesImportResult>>
  subscribe(changed: (directory: string | null) => void): () => void
}

export const localTerminalNotesPorts: TerminalNotesPorts = {
  get: (sessionId) => AppControl.library('directoryNotes.get', { sessionId }),
  save: (sessionId, notes) => AppControl.library('directoryNotes.save', { sessionId, notes }),
  importPrompt: (sessionId) => AppControl.value('directoryNotes.importPrompt', { sessionId }),
  subscribe: (changed) => window.appClient.onDirectoryNotesChanged(changed),
}
