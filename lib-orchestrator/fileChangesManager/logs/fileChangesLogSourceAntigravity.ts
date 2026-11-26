import { FileChangesLogSource, type ParsedSubagentLog } from './fileChangesLogSource'

/**
 * File mutations (`edit_file`, `write_file`) and shell command runs (`run_command`) of an
 * Antigravity CLI transcript (`transcript.jsonl`); the per-record rules live in
 * `sessionMutationsView.ts`. Antigravity sub-agent transcripts have no reader yet.
 */
export class FileChangesLogSourceAntigravity extends FileChangesLogSource {
  readonly agentId = 'antigravity' as const

  protected parseSubagent(): ParsedSubagentLog {
    return { startedAt: null, mutations: [], shellRuns: [] }
  }
}
