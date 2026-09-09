import type { SessionRecord } from './records/sessionRecord.types'
import { LaunchPlanner } from './launch/launchPlanner'
import type { SessionInfo } from './sessionManagerApi.types'

export class SessionWorkingDirectory {
  static of(info: SessionInfo): string | null {
    if (info.worktree !== undefined) return info.worktree.worktreePath
    if (info.directory.mode === 'project') return info.directory.projectPath
    else if (info.directory.mode === 'adHoc') return info.directory.path
    else if (info.directory.mode === 'default') return null
    else throw new Error(`Unknown session directory: ${JSON.stringify(info.directory)}`)
  }

  static ofRecord(record: SessionRecord): string {
    return LaunchPlanner.cwdOf(record)
  }
}
