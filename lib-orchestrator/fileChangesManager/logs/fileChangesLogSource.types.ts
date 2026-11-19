import type { FileChangeLocation, FileChangeStatus } from '../fileChangesManagerApi.types'

export type FileChangesLogMutationKind = 'add' | 'update' | 'delete' | 'write' | 'move'

export interface FileChangesLogMutation {
  mutationId: string
  kind: FileChangesLogMutationKind
  status: FileChangeStatus
  path: string
  previousPath: string | null
  location: FileChangeLocation
  beforeContent: string | null
  afterContent: string | null
  oldText: string | null
  newText: string | null
  replaceAll: boolean
  unifiedDiff: string | null
  createdAt: number
}

export interface FileChangesLogGroup {
  groupId: string
  message: string
  createdAt: number
  mutations: readonly FileChangesLogMutation[]
}

/** A shell command the agent ran: from its call to its returned result, both as transcript times. */
export interface FileChangesShellRun {
  command: string
  startedAt: number
  endedAt: number
}

export interface RawFileChangesLogMutation extends Omit<
  FileChangesLogMutation,
  'path' | 'previousPath' | 'location'
> {
  path: string
  previousPath: string | null
}

export interface RawFileChangesLogGroup {
  groupId: string
  message: string
  createdAt: number
  mutations: readonly RawFileChangesLogMutation[]
}
