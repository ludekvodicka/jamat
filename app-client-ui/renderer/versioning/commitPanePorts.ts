import type { AppClientUiBridge, IpcResult } from '../../shared/appClientUiIpc'
import { AppClientUiReport } from '../../shared/appClientUiReport'
import type {
  VersioningSettingsField,
  VersioningSettingsSaveResult,
  VersioningSettingsValue,
} from '../../shared/versioningSettings'
import { AppControl } from '../ipc/appControl'

/**
 * The review's own channels belong to the window that shows it: a draft is that window's, and the
 * commit is a person's act. The settings beside them are the control API's like every other section.
 */
export interface CommitPanePorts {
  versioning: Pick<AppClientUiBridge['versioning'], 'openDraft' | 'readCommit' | 'commitFiles' | 'setCommitMessage' | 'runCommit' | 'closeCommit' | 'externalDiff' | 'revertCommitFile' | 'openTortoise'> & {
    getSettings(): Promise<IpcResult<VersioningSettingsValue>>
    saveSettings(value: VersioningSettingsValue, field?: VersioningSettingsField): Promise<IpcResult<VersioningSettingsSaveResult>>
  }
  openFile: AppClientUiBridge['fileChanges']['openFile']
  releaseFile: AppClientUiBridge['fileViewer']['release']
  subscribe: AppClientUiBridge['onCommitChanged']
  reportError(message: string): void
}

export class CommitPaneBridge {
  static of(): CommitPanePorts {
    return {
      versioning: {
        ...window.appClient.versioning,
        getSettings: () => AppControl.value('versioningSettings.get', {}),
        saveSettings: async (value, field) => await AppControl.library('versioningSettings.save', {
          value,
          ...(field === undefined ? {} : { field }),
        }) as IpcResult<VersioningSettingsSaveResult>,
      },
      openFile: window.appClient.fileChanges.openFile,
      releaseFile: window.appClient.fileViewer.release,
      subscribe: window.appClient.onCommitChanged,
      reportError: AppClientUiReport.error,
    }
  }
}
