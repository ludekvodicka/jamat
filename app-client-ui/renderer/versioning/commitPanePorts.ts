import type { AppClientUiBridge } from '../../shared/appClientUiIpc'
import { AppClientUiReport } from '../../shared/appClientUiReport'

export interface CommitPanePorts {
  versioning: Pick<AppClientUiBridge['versioning'], 'openDraft' | 'readCommit' | 'commitFiles' | 'setCommitMessage' | 'runCommit' | 'closeCommit' | 'getSettings' | 'externalDiff' | 'revertCommitFile' | 'openTortoise'>
  openFile: AppClientUiBridge['fileChanges']['openFile']
  releaseFile: AppClientUiBridge['fileViewer']['release']
  subscribe: AppClientUiBridge['onCommitChanged']
  reportError(message: string): void
}

export class CommitPaneBridge {
  static of(): CommitPanePorts {
    return {
      versioning: window.appClient.versioning,
      openFile: window.appClient.fileChanges.openFile,
      releaseFile: window.appClient.fileViewer.release,
      subscribe: window.appClient.onCommitChanged,
      reportError: AppClientUiReport.error,
    }
  }
}
