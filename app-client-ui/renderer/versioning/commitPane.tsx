import type { VersioningCommitDraftDto } from '../../shared/versioningCommit'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { FileChangeEntry } from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import { VersioningSettings } from '../../shared/versioningSettings'
import { VersioningCommitReceipts, VersioningRevert } from '../../shared/versioningCommit'
import type { VersioningCommitPhase } from '../../shared/versioningCommit'
import type { FileViewerChangedOpen } from '../fileViewer/fileViewerPanel.types'
import { FileChangesOpen } from '../fileViewer/fileChangesOpen'
import { useWorkingTreeChanges } from '../fileViewer/useWorkingTreeChanges'
import { IpcFailure } from '../ipc/ipcFailure'
import type { PanelSplitCommitItem } from '../widgets/tabs/panelSplit'
import { CommitEditorLayout } from './commitEditorLayout'
import { CommitMessageBox } from './commitMessageBox'
import { CommitProgress } from './commitProgress'
import type { CommitPanePorts } from './commitPanePorts'
import { CommitTargetsList } from './commitTargetsList'
import { CommitTargets } from '../../shared/commitTargets'
import { useCommitDraft } from './useCommitDraft'
import './commitPane.css'

export interface CommitPaneDraftState {
  repositories?: VersioningCommitDraftDto['repositories']
  saveRepositoryMessage?(root: string, message: string): Promise<VersioningCommitDraftDto | null>
  /** The proof an approval sends, `lost` when the channel to the source refused the save before it, or null when the review changed. */
  review?: () => Promise<import('../workflow/workflowPane').WorkflowReviewProof | { lost: import('./commitPanePorts').CommitPaneChannelLoss } | null>
  checked: readonly string[]
  message: string
  messageSource?: VersioningCommitDraftDto['messageSource']
  messageFindings?: VersioningCommitDraftDto['messageFindings']
  phase: VersioningCommitPhase | null
  ready: boolean
  hasChanges: boolean
  canCommit: boolean
}

export function CommitPane(props: {
  sessionId: string
  item: PanelSplitCommitItem
  ports: CommitPanePorts
  reviewOnly?: boolean
  footer?(state: CommitPaneDraftState): React.ReactNode
  /** Replaces the one message box when each repository of the review commits with its own message. */
  messageEditor?: React.ReactNode
  onDraftState?(state: CommitPaneDraftState): void
  /** The host holds unsent text of its own, such as repository messages typed into `messageEditor`. */
  unsentText?: boolean
  onReloadEdits?(): void
  onClose(): void
  onOpenChanged(value: FileViewerChangedOpen): string | null
  onOpenSeparately(scopeRoot: string): void
  onOpenReview?(review: { draftId: string; scopeRoot: string; title: string }): void
}): React.JSX.Element {
  const ports = props.ports
  const model = useCommitDraft(props.sessionId, props.item, ports, props.reviewOnly)
  const draft = model.draft
  const draftId = draft?.draftId
  // The rows main checks by default, kept per list: a review that named its targets starts with
  // only those checked; the other rows main shows (work below a node-only folder) stay unchecked.
  const checkedByDefault = useRef<{ snapshotId: string; paths: ReadonlySet<string> } | null>(null)
  const read = useCallback(async () => {
    const answer = await ports.versioning.commitFiles(draftId ?? '')
    if (answer.ok && answer.value.ok) {
      // Listing initializes the shared selection and advances its revision before this pane can edit.
      await model.sync()
      checkedByDefault.current = answer.value.checkedPaths === undefined ? null
        : { snapshotId: answer.value.value.snapshotId, paths: new Set(answer.value.checkedPaths) }
    }
    return answer
  }, [ports, draftId, model.sync])
  const working = useWorkingTreeChanges(props.sessionId, read, draft !== null, draft?.source)
  useEffect(() => { if (draft !== null) working.select(draft.source) }, [draft?.source])
  const snapshot = draft === null ? null : working.snapshotFor(draft.source)
  const latestSnapshot = useRef(snapshot)
  useEffect(() => { latestSnapshot.current = snapshot }, [snapshot])
  const [selection, setSelection] = useState<{ draftId: string; paths: ReadonlySet<string> } | null>(null)
  const namedTargets = draft?.paths !== undefined
  // SVN recovery can introduce conflict backups after the person reviewed the original paths.
  useEffect(() => {
    if (draftId === undefined || snapshot === null || working.loading || working.requiredLoading
      || working.error !== null || working.requiredError !== null) return
    const named = checkedByDefault.current?.snapshotId === snapshot.snapshotId ? checkedByDefault.current.paths : null
    // A list whose default rows are unknown never falls back to checking the whole scope.
    if (namedTargets && named === null) return
    if (model.conflict) return
    setSelection((held) => draft?.selection !== undefined ? { draftId, paths: new Set(draft.selection.paths) } : held?.draftId === draftId ? held
      : { draftId, paths: new Set(CommitTargets.eligible(snapshot).filter((entry) => entry.origin !== 'setup' && (named === null || named.has(entry.path))).map((entry) => entry.path)) })
  }, [draftId, draft?.selection, model.conflict, namedTargets, snapshot, working.loading, working.requiredLoading, working.error, working.requiredError])
  const held = selection?.draftId === draftId ? selection
    : draft?.selection ? { draftId, paths: new Set(draft.selection.paths) } : null
  const checked = new Set(snapshot === null || (namedTargets && held === null) ? [] : CommitTargets.eligible(snapshot)
    .filter((entry) => held === null ? entry.origin !== 'setup' : held.paths.has(entry.path)).map((entry) => entry.fileId))
  const selectedCount = snapshot === null ? 0 : CommitTargets.selected(CommitTargets.eligible(snapshot), checked).length
  const revertible = snapshot === null ? [] : CommitTargets.eligible(snapshot)
    .filter((entry) => checked.has(entry.fileId) && VersioningRevert.allows(entry)
      && !snapshot.externalRoots.some((root) => root.fileIds.includes(entry.fileId)))
  const setChecked = (ids: ReadonlySet<string>): void => {
    if (snapshot === null || draftId === undefined) return
    void model.saveSelection(snapshot.snapshotId, [...ids])
    setSelection({ draftId, paths: new Set(snapshot.entries.filter((entry) => ids.has(entry.fileId)).map((entry) => entry.path)) })
  }
  const [note, setNote] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [commitStartedAt, setCommitStartedAt] = useState<number | null>(null)
  const [opening, setOpening] = useState(false)
  const [externalConfigured, setExternalConfigured] = useState(false)
  const settingsRead = useRef(0)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const cancelled = draft?.phase.kind === 'cancelled'
  const busy = running || draft?.phase.kind === 'running' || draft?.externalReview === 'running' || cancelled
  const done = draft?.phase.kind === 'done'
  const close = useRef(props.onClose)
  close.current = props.onClose
  useEffect(() => { if (cancelled && !props.reviewOnly) close.current() }, [cancelled, draftId, props.reviewOnly])
  const [closeEmpty, setCloseEmpty] = useState(false)
  const reload = async (closeIfEmpty: boolean): Promise<void> => {
    setCloseEmpty(closeIfEmpty)
    await working.reload()
  }
  const populatedDraft = useRef<string | null>(null)
  useEffect(() => {
    if (draftId === undefined || snapshot === null || working.loading || working.requiredLoading
      || working.error !== null || working.requiredError !== null || model.error !== null) return
    if (snapshot.entries.length > 0) {
      populatedDraft.current = draftId
      return
    }
    if (props.reviewOnly || !closeEmpty || busy || done || snapshot.warnings.length > 0 || populatedDraft.current !== draftId) return
    populatedDraft.current = null
    close.current()
  }, [draftId, snapshot, closeEmpty, busy, done, working.loading, working.requiredLoading,
    working.error, working.requiredError, model.error, props.reviewOnly])
  useEffect(() => {
    const completed = draft?.phase
    if (props.reviewOnly || completed?.kind !== 'done' || VersioningCommitReceipts.unresolved(draft).length > 0) return
    let disposed = false
    const report = (detail: string): void => {
      if (!disposed) setNote(`Committed ${completed.revision}\n${completed.output}\n\nCould not read automatic closing setting: ${detail}`)
    }
    void ports.versioning.getSettings().then((answer) => {
      if (disposed) return
      if (!answer.ok) { report(answer.error); return }
      if (answer.value.closeCommitOnSuccess !== false) close.current()
    }).catch((error: unknown) => report(String(error)))
    return () => { disposed = true }
  }, [done, draftId, ports, props.reviewOnly])
  const canCommit = model.error === null && model.conflict === null && !busy && !done && !working.loading && !working.requiredLoading
    && working.error === null && working.requiredError === null && snapshot !== null && checked.size > 0 && !!draft?.message.trim()
  const refreshDiffSettings = async (): Promise<void> => {
    if (draft?.externalDiffAvailable !== undefined) { setExternalConfigured(draft.externalDiffAvailable); return }
    const revision = ++settingsRead.current
    setExternalConfigured(false)
    const answer = await ports.versioning.getSettings()
    if (!mounted.current || revision !== settingsRead.current) return
    setExternalConfigured(answer.ok && answer.value.diffTool.kind === 'external' && VersioningSettings.isDiffTool(answer.value.diffTool))
    if (!answer.ok) setNote(answer.error)
  }
  const revert = async (fileIds: readonly string[]): Promise<void> => {
    if (draft === null || snapshot === null || busy || done || fileIds.length === 0) return
    setRunning(true)
    setNote(null)
    try {
      let answer
      if (ports.versioning.decideCommit && draft.epoch) {
        const accepted = await model.saveSelection(snapshot.snapshotId, [...checked])
        if (!accepted?.epoch) return
        if (!ports.confirmRevert || !await ports.confirmRevert(snapshot.entries.filter((entry) => fileIds.includes(entry.fileId)).map((entry) => entry.path), draft.vcs)) return
        answer = await ports.versioning.decideCommit({ kind: 'revert', draftId: draft.draftId, epoch: accepted.epoch, expectedRevision: accepted.revision,
          operationId: crypto.randomUUID(), snapshotId: snapshot.snapshotId, fileIds, confirmed: true })
      } else answer = await ports.versioning.revertCommitFile({ draftId: draft.draftId, snapshotId: snapshot.snapshotId, fileIds })
      if (!mounted.current) return
      setNote(IpcFailure.of(answer))
      if (!answer.ok || !answer.value.ok || !('reverted' in answer.value) || answer.value.reverted) await reload(answer.ok && answer.value.ok)
    } catch (error) { if (mounted.current) setNote(String(error)) }
    finally { if (mounted.current) setRunning(false) }
  }
  const open = async (entry: FileChangeEntry): Promise<void> => {
    if (snapshot === null || opening || busy || done || entry.nodeKind !== 'file') return
    setOpening(true)
    setNote(null)
    try {
      const baseline = snapshot.defaultBaseline
      const isCurrent = (fresh: FileViewerChangedOpen['snapshot']): boolean => mounted.current
        && (latestSnapshot.current?.snapshotId === snapshot.snapshotId || latestSnapshot.current?.snapshotId === fresh.snapshotId)
      const opened = await FileChangesOpen.read({ snapshot, entry, openFile: ports.openFile,
        baselineHint: baseline === null || snapshot.source.selected === null ? null
          : { kind: baseline.kind, revision: baseline.revision, workingTreeSource: snapshot.source.selected },
        refresh: () => working.reload(snapshot.source.selected ?? undefined), isCurrent })
      const { answer } = opened
      const refusal = IpcFailure.of(answer)
      if (refusal !== null) { if (isCurrent(opened.snapshot)) setNote(refusal); return }
      if (!answer.ok || !answer.value.ok) return
      try {
        if (!isCurrent(opened.snapshot)) return
        setNote(props.onOpenChanged({ document: answer.value.value, snapshot: opened.snapshot,
          fileId: opened.fileId, baselineHint: opened.baselineHint }))
      } finally { await ports.releaseFile(answer.value.value.documentId) }
    } finally { if (mounted.current) setOpening(false) }
  }
  const openExternal = async (entry: FileChangeEntry): Promise<void> => {
    if (snapshot === null || opening || busy || done || entry.nodeKind !== 'file') return
    const baseline = snapshot.defaultBaseline
    if (baseline === null) { setNote('There is no baseline for this file'); return }
    setOpening(true)
    try {
      const answer = ports.versioning.decideCommit && draft?.epoch
        ? await ports.versioning.decideCommit({ kind: 'external-diff', draftId: draft.draftId, epoch: draft.epoch, expectedRevision: draft.revision,
          operationId: crypto.randomUUID(), snapshotId: snapshot.snapshotId, fileId: entry.fileId, baselineId: baseline.baselineId })
        : await ports.versioning.externalDiff({ snapshotId: snapshot.snapshotId, fileId: entry.fileId, baselineId: baseline.baselineId })
      if (mounted.current) setNote(!answer.ok ? answer.error : !answer.value.ok ? answer.value.detail : null)
    } finally { if (mounted.current) setOpening(false) }
  }
  const run = async (): Promise<void> => {
    if (draft === null || snapshot === null || !canCommit) return
    setRunning(true)
    setCommitStartedAt(Date.now())
    setNote(null)
    try {
      const accepted = await model.saveSelection(snapshot.snapshotId, [...checked])
      if (accepted === null) return
      const request = { ...(accepted.epoch ? { epoch: accepted.epoch, expectedRevision: accepted.revision } : {}), draftId: draft.draftId, snapshotId: snapshot.snapshotId, fileIds: [...checked], message: draft.message,
        ...(draft.vcs === 'svn' ? { includeExternals: true as const } : {}) }
      const answer = ports.versioning.decideCommit && accepted.epoch
        ? await ports.versioning.decideCommit({ ...request, kind: 'approve', operationId: crypto.randomUUID(), epoch: accepted.epoch, expectedRevision: accepted.revision })
        : await ports.versioning.runCommit(request)
      if (!mounted.current) return
      setNote(IpcFailure.of(answer))
      model.refresh()
      if (answer.ok && !answer.value.ok && answer.value.reloadRequired) {
        const invalidList = answer.value.code === 'invalid-target'
        if (invalidList) setNote('Reloading the file list...')
        await reload(invalidList)
        if (mounted.current && invalidList)
          setNote('File list reloaded. Review the files and selection, then click Commit files again.')
      }
    } finally { if (mounted.current) { setRunning(false); setCommitStartedAt(null) } }
  }
  const openSeparate = async (scopeRoot: string): Promise<void> => {
    if (!ports.splitReview) { props.onOpenSeparately(scopeRoot); return }
    if (!draft || !snapshot || !props.onOpenReview) { setNote('A separate review cannot open in this workspace'); return }
    const answer = await ports.splitReview(draft.draftId, snapshot.snapshotId, scopeRoot)
    if (!mounted.current) return
    setNote(IpcFailure.of(answer))
    if (answer.ok && answer.value.ok) props.onOpenReview(answer.value.value)
  }
  const openTortoise = async (): Promise<void> => {
    if (draft === null || busy || done) return
    setRunning(true)
    setNote('Tortoise is open. Close its dialog to refresh this list.')
    try {
      let answer
      if (ports.versioning.decideCommit && draft.epoch && snapshot) {
        const accepted = await model.saveSelection(snapshot.snapshotId, [...checked])
        if (!accepted?.epoch) return
        answer = await ports.versioning.decideCommit({ kind: 'external-review', draftId: draft.draftId, epoch: accepted.epoch, expectedRevision: accepted.revision,
          operationId: crypto.randomUUID(), snapshotId: snapshot.snapshotId, fileIds: [...checked], message: accepted.message })
      } else answer = await ports.versioning.openTortoise(draft.draftId, draft.message)
      if (!mounted.current) return
      setNote(IpcFailure.of(answer))
      await reload(answer.ok && answer.value.ok)
    } finally { if (mounted.current) setRunning(false) }
  }
  const phase = draft?.phase
  let status: string | null = null
  if (phase === undefined || phase.kind === 'editing') status = null
  else if (phase.kind === 'running') status = phase.detail ?? 'Committing...'
  else if (phase.kind === 'done') status = `Committed ${phase.revision}\n${phase.output}`
  else if (phase.kind === 'failed') status = phase.detail
  else if (phase.kind === 'cancelled') status = 'Review cancelled'
  else throw new Error(`Unknown commit phase: ${JSON.stringify(phase)}`)
  if (draft?.externalReview === 'running') status = 'External review is open on the source computer.'
  else if (draft?.externalReview === 'closed' && !done) status = 'External review closed. Publication is not proved; reload and inspect the remaining files.'
  // A clean scope drawn as a bare empty list read as a list that failed to load (#24). A read that
  // came back with warnings may be empty because it failed, so only a clean read may say this.
  const nothingToCommit = snapshot !== null && !working.loading && snapshot.entries.length === 0
    && snapshot.warnings.length === 0 && snapshot.source.selected !== null
  const checkedPaths = JSON.stringify(snapshot === null ? [] : CommitTargets.selected(CommitTargets.eligible(snapshot), checked)
    .flatMap((entry) => entry.status === 'renamed' && entry.previousPath !== null ? [entry.path, entry.previousPath] : [entry.path]))
  const selectedIds = JSON.stringify([...checked])
  const review = useCallback(async () => {
    if (!snapshot) return null
    const fileIds: string[] = JSON.parse(selectedIds)
    const { draft: saved, lost } = await model.reviewSelection(snapshot.snapshotId, fileIds)
    if (lost !== null) return { lost }
    return saved?.epoch ? { draftId: saved.draftId, epoch: saved.epoch, expectedRevision: saved.revision,
      snapshotId: snapshot.snapshotId, fileIds, message: saved.message } : null
  }, [snapshot?.snapshotId, selectedIds, model.reviewSelection])
  const footerState = useMemo<CommitPaneDraftState>(() => ({ repositories: draft?.repositories, saveRepositoryMessage: model.saveRepositoryMessage, checked: JSON.parse(checkedPaths) as string[], message: draft?.message ?? '', messageSource: draft?.messageSource ?? 'unknown', messageFindings: draft?.messageFindings,
    ...(ports.versioning.decideCommit && draft?.epoch ? { review } : {}),
    phase: phase ?? null, canCommit, hasChanges: (snapshot?.entries.length ?? 0) > 0, ready: draft !== null && snapshot !== null && !busy && !done && !working.loading
      && !working.requiredLoading && working.error === null && working.requiredError === null && model.error === null }),
  [checkedPaths, draft?.repositories, model.saveRepositoryMessage, draft?.message, draft?.messageSource, draft?.messageFindings, draft?.epoch, ports.versioning.decideCommit, review, phase, canCommit, draft !== null, snapshot !== null, snapshot?.entries.length, busy, done, working.loading,
    working.requiredLoading, working.error, working.requiredError, model.error])
  useEffect(() => { props.onDraftState?.(footerState) }, [footerState, props.onDraftState])
  const changedMessages = model.conflict === null ? [] : CommitPaneConflict.changedRepositories(model.conflict, model.conflictHeld)
  return <section className="commit-pane" tabIndex={-1} aria-label={`${props.item.vcs.toUpperCase()} commit dialog`}
    onKeyDownCapture={(event) => {
      if (props.reviewOnly) return
      if (event.nativeEvent.isComposing || event.repeat || event.altKey || event.ctrlKey || event.metaKey
        || (event.target instanceof Element && event.target.closest('[role="menu"]'))) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        if (!busy) props.onClose()
      } else if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        event.stopPropagation()
        if (canCommit) void run()
      }
    }}>
    {/* The working copy, and only that: the paths this commit was restricted to are listed in the
        tooltip, because the heading is one line and the list under it already names every file. */}
    <strong className="commit-scope" title={draft?.scopeTooltip ?? props.item.scopeRoot}>{draft?.scopeRoot ?? props.item.scopeRoot}</strong>
    {draft !== null && <CommitEditorLayout settings={ports.versioning} reportError={ports.reportError} files={snapshot !== null && !done ? <CommitTargetsList snapshot={snapshot} checked={checked} disabled={busy} separateMessages={props.messageEditor !== undefined}
      onMenuOpen={() => { void refreshDiffSettings() }} onOpenExternal={externalConfigured ? (entry) => { void openExternal(entry) } : null}
      onChange={setChecked} onOpen={(entry) => { void open(entry) }} onRevert={(entry) => { void revert([entry.fileId]) }} onOpenSeparately={(root) => { void openSeparate(root) }} /> : null}
      message={props.messageEditor ?? <CommitMessageBox value={draft.message} disabled={busy || done || snapshot === null || working.loading || working.requiredLoading} source={draft.messageSource ?? 'unknown'} findings={props.reviewOnly ? draft.messageFindings : undefined} proposed={draft.proposedByAgent && !draft.editedByPerson} reviewOnly={props.reviewOnly} onChange={model.setMessage} />} />}
    {phase?.kind === 'running' ? <CommitProgress phase={phase} />
      : commitStartedAt !== null && !done
        ? <CommitProgress phase={{ kind: 'running', startedAt: commitStartedAt }} /> : null}
    <div role="status" className="commit-status">
      {model.error ?? working.error ?? working.requiredError ?? note ?? status
        ?? (working.loading && draft !== null ? 'Reading changes...' : draft === null ? 'Opening commit dialog...'
          : nothingToCommit ? 'Nothing to commit: this scope has no changes' : `${selectedCount} selected`)}
    </div>
    {model.conflict !== null && <div role="alert">
      <p>{model.unsent || props.unsentText ? 'Shared review changed. Your unsent text is retained above.' : 'Shared review changed.'}</p>
      <details><summary>Compare source message</summary>{props.messageEditor === undefined
        ? <pre>{model.conflict.message}</pre>
        : changedMessages.length === 0 ? <p>No repository message changed.</p>
        : changedMessages.map((repository) => <div key={repository.root}>
          <strong>{repository.repositoryName}</strong> <span title={repository.root}>{repository.root}</span><pre>{repository.message}</pre>
        </div>)}</details>
      {model.unsent && <button type="button" onClick={model.keepEdits}>Use my text</button>}
      <button type="button" onClick={() => { model.reloadEdits(); props.onReloadEdits?.() }}>Reload shared edits</button>
    </div>}
    {draft?.published && draft.published.length > 0 && <details><summary>Published changes</summary>
      {draft.published.map((receipt, index) => <pre key={index}>{`${receipt.scopeRoot}: ${receipt.revision}\n${receipt.paths?.join('\n') ?? 'Exact published paths were not reported.'}`}</pre>)}
    </details>}
    {VersioningCommitReceipts.unresolved(draft).map((receipt, index) => <div role="alert" key={index}>
      <p>SVN published revision {receipt.revision}, but did not report these selected paths. Inspect the revision and remaining changes before another commit.</p>
      <pre>{receipt.omittedPaths!.join('\n')}</pre>
    </div>)}
    {snapshot?.warnings.map((warning) => <p className="commit-warning" key={warning}>{warning}</p>)}
    {props.footer !== undefined ? props.footer(footerState) : <div className="commit-actions">
      <div className="commit-actions-left">
        {!done && draft !== null && <button type="button" className="commit-submit" disabled={!canCommit} onClick={() => { void run() }}>Commit files</button>}
        <button type="button" disabled={busy} onClick={props.onClose}>Close view</button>
        {!done && draft !== null && (ports.versioning.cancelCommit || ports.versioning.decideCommit) && <button type="button" disabled={busy} onClick={() => {
          if (ports.versioning.decideCommit && draft.epoch) {
            void ports.versioning.decideCommit({ kind: 'cancel', draftId: draft.draftId, epoch: draft.epoch, expectedRevision: draft.revision, operationId: crypto.randomUUID() })
              .then((answer) => { setNote(IpcFailure.of(answer)); model.refresh() })
            return
          }
          void ports.versioning.cancelCommit!(draft.draftId).then((answer) => {
            if (!answer.ok) setNote(answer.error)
            else if (!answer.value.ok) setNote(answer.value.error.detail)
            model.refresh()
          })
        }}>Cancel review</button>}
      </div>
      <div className="commit-actions-right">
        {!done && draft !== null && <button type="button" disabled={busy || working.loading} onClick={() => { setNote(null); void reload(true) }}>Reload</button>}
        {!done && draft !== null && <button type="button" disabled={busy || working.loading || revertible.length === 0}
          title="Revert checked modified, missing or deleted files. Added files, folders, moves and conflicts are excluded."
          onClick={() => { void revert(revertible.map((entry) => entry.fileId)) }}>Revert selected ({revertible.length})…</button>}
        {!done && draft !== null && <button type="button" disabled={busy}
          title={`Open this folder in the Tortoise${draft.vcs === 'svn' ? 'SVN' : 'Git'} commit dialog with the current message`}
          onClick={() => { void openTortoise() }}>Open in Tortoise</button>}
      </div>
    </div>}
  </section>
}

/** With one message per repository, the comparison shows the repository messages the source changed since this pane read them. */
class CommitPaneConflict {
  static changedRepositories(current: VersioningCommitDraftDto, held: VersioningCommitDraftDto | null): NonNullable<VersioningCommitDraftDto['repositories']> {
    return (current.repositories ?? []).filter((repository) => held?.repositories?.find((before) =>
      before.root === repository.root && before.repository === repository.repository)?.message !== repository.message)
  }
}
