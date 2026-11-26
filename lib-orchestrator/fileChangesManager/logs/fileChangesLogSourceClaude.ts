import { FileChangesLogSource } from './fileChangesLogSource'

/** Claude Code transcripts; the per-record rules live in `sessionMutationsView.ts`. */
export class FileChangesLogSourceClaude extends FileChangesLogSource {
  readonly agentId = 'claude' as const
}
