import { FileChangesLogSource } from './fileChangesLogSource'

/** Codex rollouts; the per-record rules and the child listing's start live in `sessionMutationsView.ts`. */
export class FileChangesLogSourceCodex extends FileChangesLogSource {
  readonly agentId = 'codex' as const
}
