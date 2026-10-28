import type { AppClientUiBridge, IpcResult } from '../../shared/appClientUiIpc'
import { AppClientUiReport } from '../../shared/appClientUiReport'
import type {
  VersioningSettingsField,
  VersioningSettingsSaveResult,
  VersioningSettingsValue,
} from '../../shared/versioningSettings'
import { AppControl } from '../ipc/appControl'

/**
 * Review decisions require an admitted human workspace. Settings and confirmation remain local to
 * the viewer; source reads and decisions are injected by the workspace composition.
 */
export interface CommitPanePorts {
  splitReview?(reviewId: string, snapshotId: string, scopeRoot: string): Promise<IpcResult<import('../../shared/versioningCommit').VersioningCommitOpenResult>>
  confirmRevert?(paths: readonly string[], vcs: 'svn' | 'git'): Promise<boolean>
  identity?: string
  generation?: number
  projectReview?(draft: import('../../shared/versioningCommit').VersioningCommitDraftDto, itemKey: string, openId: string): Promise<unknown>
  versioning: Partial<Pick<AppClientUiBridge['versioning'], 'cancelCommit' | 'editCommit' | 'decideCommit'>> & Pick<AppClientUiBridge['versioning'], 'openDraft' | 'readCommit' | 'commitFiles' | 'setCommitMessage' | 'runCommit' | 'closeCommit' | 'externalDiff' | 'revertCommitFile' | 'openTortoise'> & {
    getSettings(): Promise<IpcResult<VersioningSettingsValue>>
    saveSettings(value: VersioningSettingsValue, field?: VersioningSettingsField): Promise<IpcResult<VersioningSettingsSaveResult>>
  }
  openFile: AppClientUiBridge['fileChanges']['openFile']
  releaseFile: AppClientUiBridge['fileViewer']['release']
  subscribe: AppClientUiBridge['onCommitChanged']
  reportError(message: string): void
}

/**
 * What the channel to a review's source proved when it answered instead of the source: the request
 * timed out or the connection was gone, so the source may or may not have acted on it. `accepted` is
 * true only when a source read after the request already showed its approval accepted. Ports whose
 * source is in this process never return it.
 */
export interface CommitPaneChannelLoss {
  computer: string
  accepted: boolean
}

export type CommitPaneChannelFailure = { ok: false; error: string; channelLost: CommitPaneChannelLoss }

export class CommitPaneChannel {
  static lossOf(answer: IpcResult<unknown>): CommitPaneChannelLoss | null {
    return !answer.ok && 'channelLost' in answer ? (answer as CommitPaneChannelFailure).channelLost : null
  }

  /** The approval itself was never sent: the review read before it is what the channel lost. */
  static notSentOf(loss: CommitPaneChannelLoss): string {
    return `Not sent: the connection to ${loss.computer} is lost; nothing was approved.`
  }

  /** The approval was sent and no answer came back. */
  static unansweredOf(loss: CommitPaneChannelLoss): string {
    return loss.accepted
      ? `The source accepted the approval; the outcome is unknown until the connection to ${loss.computer} returns.`
      : `No answer from ${loss.computer}: the connection is lost, so whether the source accepted the approval is unknown until it returns.`
  }
}

export class CommitPaneBridge {
  static viewer(): Pick<CommitPanePorts, 'confirmRevert'> & { versioning: Pick<CommitPanePorts['versioning'], 'getSettings' | 'saveSettings'> } {
    return {
      confirmRevert: async (paths, vcs) => {
        const answer = await window.appClient.dialog.confirm(`Revert ${paths.length} ${vcs.toUpperCase()} file(s)?`, `Discard local changes in:\n${paths.join('\n')}`)
        if (!answer.ok) throw new Error(answer.error)
        return answer.value
      },
      versioning: {
        getSettings: () => AppControl.value('versioningSettings.get', {}),
        saveSettings: async (value, field) => await AppControl.library('versioningSettings.save', {
          value,
          ...(field === undefined ? {} : { field }),
        }) as IpcResult<VersioningSettingsSaveResult>,
      },
    }
  }

  static of(): CommitPanePorts {
    const viewer = CommitPaneBridge.viewer()
    return {
      ...viewer,
      versioning: { ...window.appClient.versioning, ...viewer.versioning },
      openFile: window.appClient.fileChanges.openFile,
      releaseFile: window.appClient.fileViewer.release,
      subscribe: window.appClient.onCommitChanged,
      reportError: AppClientUiReport.error,
    }
  }
}
