import type { SessionScriptsInfo, SessionScriptOutput } from '../sessionManager/sessionManagerApi.types'
import type { SessionTaskListing, SessionSubagentTranscript, SessionShellOutput } from '../sessionTasks/sessionTasksApi.types'

export type RemoteTaskRequest =
  | { kind: 'list' }
  | { kind: 'transcript'; subagentId: string; known?: string }
  | { kind: 'shell'; shellId: string; known?: string }
  | { kind: 'script'; runId: string }

export interface RemoteTaskListing { listing: SessionTaskListing; scripts: SessionScriptsInfo | null }
export type RemoteTaskValue = RemoteTaskListing | SessionSubagentTranscript | SessionShellOutput | SessionScriptOutput
