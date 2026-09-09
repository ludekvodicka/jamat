import type { FileChangeStatus } from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'

export class FileChangesStatusMark {
  static of(status: FileChangeStatus): string {
    if (status === 'added') return 'A'
    else if (status === 'modified') return 'M'
    else if (status === 'deleted') return 'D'
    else if (status === 'renamed') return 'R'
    else if (status === 'replaced') return 'P'
    else if (status === 'copied') return 'C'
    else if (status === 'untracked') return '?'
    else if (status === 'conflicted') return '!'
    else if (status === 'missing') return '_'
    else if (status === 'obstructed') return 'X'
    else throw new Error(`Unknown file change status: ${JSON.stringify(status)}`)
  }
}
