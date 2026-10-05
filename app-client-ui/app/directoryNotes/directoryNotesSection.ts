import type { ConfigSectionSpec } from '../../../lib-orchestrator/configStore/configStore.types'
import { DirectoryNotes, type DirectoryNotesValue } from '../../shared/directoryNotes'

export class DirectoryNotesSection {
  static readonly spec: ConfigSectionSpec<DirectoryNotesValue> = {
    key: 'directoryNotes',
    coerce: (value, report) => DirectoryNotes.coerce(value, report),
    // A hand edit that broke the shape is refused its own save instead of being replaced by what
    // `coerce` could read of it: the notes it left out would be gone.
    damaged: (value) => DirectoryNotes.damaged(value),
    validate: (value) => DirectoryNotes.shapeProblemOf(value),
  }
}
