import type { VersioningCommitDraftDto, VersioningCommitOpenResult } from '../../shared/versioningCommit'
import type { RemoteReviewRequest } from '../../../lib-orchestrator/remoteControl/remoteReviewApi.types'
import type { RemoteSessionView } from '../../../lib-orchestrator/remoteControl/remoteSessionApi.types'
import type { AppClientUiBridge, IpcResult } from '../../shared/appClientUiIpc'
import type { SessionTarget } from '../../shared/sessionWorkspace'
import { RemoteContentRead } from '../../shared/remoteContentRead'
import { RemoteReviewResults } from '../../shared/remoteReviewResults'
import { RemoteRequestError } from '../../shared/remoteRequestError'
import type { CommitPaneChannelFailure, CommitPanePorts } from './commitPanePorts'

export class RemoteCommitPanePorts {
  readonly ports: CommitPanePorts
  private readonly target: Extract<SessionTarget, { kind: 'remote' }>
  private readonly open: () => Promise<RemoteSessionView>
  private readonly bridge: Pick<AppClientUiBridge['remote'], 'requestReviews' | 'readReviewPage'>
  private readonly computer: () => string
  private closed = false
  private readonly drafts = new Map<string, VersioningCommitDraftDto>()

  constructor(target: Extract<SessionTarget, { kind: 'remote' }>, generation: number, open: RemoteCommitPanePorts['open'],
    bridge: RemoteCommitPanePorts['bridge'], local: Pick<CommitPanePorts, 'subscribe' | 'reportError' | 'confirmRevert'> & {
      settings: Pick<CommitPanePorts['versioning'], 'getSettings' | 'saveSettings'>
      project?(draft: VersioningCommitDraftDto, key: string, openId: string): Promise<unknown>
      changed?(draft: VersioningCommitDraftDto, closed: boolean): Promise<unknown>
      changes: AppClientUiBridge['fileChanges']; releaseFile: CommitPanePorts['releaseFile']
      computer(): string
    }) {
    this.target = target
    this.open = open
    this.bridge = bridge
    this.computer = local.computer
    this.ports = {
      identity: JSON.stringify(target), generation, projectReview: local.project, confirmRevert: local.confirmRevert,
      splitReview: async (reviewId, snapshotId, scopeRoot) => {
        const current = await this.ports.versioning.readCommit(reviewId)
        if (!current.ok) return current
        if (!current.value?.epoch) return { ok: false, error: 'Read the source review before separating a group' }
        const opened = await this.request<import('../../shared/versioningCommit').VersioningCommitRunResult>({ kind: 'decide', decision: {
          kind: 'split', draftId: reviewId, epoch: current.value.epoch, expectedRevision: current.value.revision, snapshotId, scopeRoot, operationId: crypto.randomUUID() } })
        if (!opened.ok) return opened
        if (!opened.value.ok) return { ok: false, error: opened.value.detail }
        if (!opened.value.reviewId) return { ok: false, error: 'The source did not return the separate review identity' }
        const source = await this.request<VersioningCommitDraftDto | null>({ kind: 'read', reviewId: opened.value.reviewId })
        if (!source.ok) return source
        if (!source.value || source.value.scopeRoot !== scopeRoot) return { ok: false, error: 'The separate source review changed' }
        return { ok: true, value: { ok: true, value: { draftId: source.value.draftId, scopeRoot, title: `Commit ${source.value.vcs.toUpperCase()}` }, messageApplied: false } }
      },
      subscribe: local.subscribe, reportError: local.reportError,
      openFile: local.changes.openFile, releaseFile: local.releaseFile,
      versioning: {
        ...local.settings,
        openDraft: async (sessionId, vcs, scopeRoot, _paths, reviewId) => {
          if (sessionId !== target.sessionId || !reviewId && !scopeRoot) return { ok: false, error: 'Open an existing source review from its shared catalog' }
          const opened = await this.request<VersioningCommitOpenResult>(reviewId ? { kind: 'open', reviewId } : { kind: 'workflow', vcs, scopeRoot: scopeRoot! })
          if (opened.ok && opened.value.ok) {
            const id = opened.value.value.draftId
            const draft = await this.request<VersioningCommitDraftDto | null>({ kind: 'read', reviewId: id })
            if (draft.ok && draft.value) {
              this.drafts.set(id, draft.value)
            }
          }
          return opened
        },
        readCommit: async (reviewId) => {
          const answer = await this.request<VersioningCommitDraftDto | null>({ kind: 'read', reviewId })
          if (answer.ok && answer.value) { this.drafts.set(reviewId, answer.value); void local.changed?.(answer.value, false) }
          return answer
        },
        commitFiles: (reviewId) => this.request({ kind: 'files', reviewId }),
        editCommit: (edit) => this.request({ kind: 'edit', edit }),
        decideCommit: (decision) => this.request({ kind: 'decide', decision }),
        closeCommit: async (reviewId) => {
          if (this.closed) return { ok: false, error: 'Source review ports were retired' }
          const draft = this.drafts.get(reviewId)
          if (draft) void local.changed?.(draft, true)
          const answer = await this.request({ kind: 'release', reviewId })
          return answer.ok ? { ok: true, value: undefined } : answer
        },
        setCommitMessage: async () => ({ ok: false, error: 'Shared edits require the displayed review revision' }),
        runCommit: async () => ({ ok: false, error: 'Shared approval requires a trusted revision-bound decision' }),
        externalDiff: async () => ({ ok: false, error: 'External review action is not available' }),
        revertCommitFile: async () => ({ ok: false, error: 'Revert requires a revision-bound human decision' }),
        openTortoise: async () => ({ ok: false, error: 'External review requires a revision-bound human decision' }),
      },
    }
  }

  clear(): void { this.closed = true }

  create(vcs: 'svn' | 'git', scopeRoot?: string): Promise<IpcResult<VersioningCommitOpenResult>> {
    return this.request({ kind: 'create', vcs, openId: crypto.randomUUID(), ...(scopeRoot && scopeRoot !== '.' ? { scopeRoot } : {}) })
  }

  /**
   * The channel answered for the source. Only a source read that arrived after this decision was
   * sent, at a later revision and naming its workflow, proves the source accepted it.
   */
  private lost(request: RemoteReviewRequest, detail: string): CommitPaneChannelFailure {
    const decision = request.kind === 'decide' ? request.decision : null
    const held = decision?.kind === 'finish' ? this.drafts.get(decision.draftId) : undefined
    const accepted = decision?.kind === 'finish' && held?.workflow?.workflowId === decision.workflow.workflowId && held.revision > decision.expectedRevision
    return { ok: false, error: detail, channelLost: { computer: this.computer(), accepted } }
  }

  private async request<T>(request: RemoteReviewRequest): Promise<IpcResult<T>> {
    if (this.closed) return { ok: false, error: 'Source review ports were retired' }
    try {
      const view = await this.open()
      const first = await this.bridge.requestReviews(this.target.remoteEndpointId, view.viewId, request)
      if (!first.ok) return first
      if (!first.value.ok) {
        const { code, detail } = first.value.error
        return code === 'timeout' || code === 'unavailable' ? this.lost(request, detail) : { ok: false, error: detail }
      }
      const bytes = await RemoteContentRead.collect(first.value.value, async (cursor) => {
        const next = await this.bridge.readReviewPage(this.target.remoteEndpointId, view.viewId, cursor)
        if (!next.ok) throw new Error(next.error)
        if (!next.value.ok) throw new Error(next.value.error.detail)
        return next.value.value
      })
      if (this.closed) return { ok: false, error: 'Source review view changed' }
      const value = RemoteReviewResults.parse(request, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), this.target.sessionId)
      if (request.kind === 'files') {
        const draft = this.drafts.get(request.reviewId)
        const files = value as import('../../shared/versioningCommit').VersioningCommitFilesResult
        if (files.ok && draft) {
          const root = draft.scopeRoot.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase()
          if (files.value.source.selected !== draft.source || files.value.entries.some((entry) => {
            const path = entry.path.replace(/\\/g, '/').toLowerCase()
            return path !== root && !path.startsWith(`${root}/`)
          })) throw new Error('Review files belong to another source scope')
        }
      }
      return { ok: true, value: value as T }
    } catch (error) {
      return error instanceof RemoteRequestError && (error.code === 'timeout' || error.code === 'unavailable')
        ? this.lost(request, error.message) : { ok: false, error: String(error) }
    }
  }
}
