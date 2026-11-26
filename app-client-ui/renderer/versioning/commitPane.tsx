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
import { CommitTargetsList, type CommitRepositoryMessageItem } from './commitTargetsList'
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
  /**
   * False while the pane is not on screen (a hidden tab or another split item). Its working tree is
   * read only while it is shown, and once again when it comes back; 39 hidden panes read `svn status`
   * at every start and froze the orchestrator. Absent means shown.
   */
  visible?: boolean
  footer?(state: CommitPaneDraftState): React.ReactNode
  /** Per-repository inline message editors rendered inside each repository group card. */
  repositoryMessages?: readonly CommitRepositoryMessageItem[]
  onDraftState?(state: CommitPaneDraftState): void
  /** The host holds unsent text of its own, such as repository messages edited inline. */
  unsentText?: boolean
  onReloadEdits?(): void
  onClose(): void
  onOpenChanged(value: FileViewerChangedOpen): string | null
  onOpenSeparately(scopeRoot: string): void
  onOpenReview?(review: { draftId: string; scopeRoot: string; title: string }): void
}): React.JSX.Element {
  const ports = props.ports
  const shown = props.visible !== false
  const model = useCommitDraft(props.sessionId, props.item, ports, props.reviewOnly, shown)
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
  const working = useWorkingTreeChanges(props.sessionId, read, draft !== null && shown, shown ? draft?.source : undefined, props.item.vcs)
  useEffect(() => { if (draft !== null) working.select(draft.source) }, [draft?.source])
  const snapshot = draft === null ? null : working.snapshotFor(draft.source)
  const latestSnapshot = useRef(snapshot)
  useEffect(() => { latestSnapshot.current = snapshot }, [snapshot])
  const [selection, setSelection] = useState<{ draftId: string; paths: ReadonlySet<string> } | null>(null)
  const namedTargets = draft?.paths !== undefined
  const eligible = useMemo(() => snapshot === null ? [] : CommitTargets.eligible(snapshot), [snapshot])
  const externalFileIds = useMemo(() => {
    const ids = new Set<string>()
    if (snapshot !== null)
      for (const root of snapshot.externalRoots)
        for (const id of root.fileIds) ids.add(id)
    return ids
  }, [snapshot])
  // SVN recovery can introduce conflict backups after the person reviewed the original paths.
  useEffect(() => {
    if (draftId === undefined || snapshot === null || working.loading || working.requiredLoading
      || working.error !== null || working.requiredError !== null) return
    const named = checkedByDefault.current?.snapshotId === snapshot.snapshotId ? checkedByDefault.current.paths : null
    // A list whose default rows are unknown never falls back to checking the whole scope.
    if (namedTargets && named === null) return
    if (model.conflict) return
    setSelection((held) => draft?.selection !== undefined ? { draftId, paths: new Set(draft.selection.paths) } : held?.draftId === draftId ? held
      : { draftId, paths: new Set(eligible.filter((entry) => entry.origin !== 'setup' && (named === null || named.has(entry.path))).map((entry) => entry.path)) })
  }, [draftId, draft?.selection, eligible, model.conflict, namedTargets, snapshot, working.loading, working.requiredLoading, working.error, working.requiredError])
  const heldPaths = useMemo(() => selection !== null && selection.draftId === draftId ? selection.paths
    : draft?.selection ? new Set(draft.selection.paths) : null, [selection, draftId, draft?.selection])
  const checked = useMemo(() => new Set(snapshot === null || (namedTargets && heldPaths === null) ? [] : eligible
    .filter((entry) => heldPaths === null ? entry.origin !== 'setup' : heldPaths.has(entry.path)).map((entry) => entry.fileId)),
  [snapshot, namedTargets, heldPaths, eligible])
  const selectedEntries = useMemo(() => snapshot === null ? [] : CommitTargets.selected(eligible, checked), [snapshot, eligible, checked])
  const selectedCount = selectedEntries.length
  const revertible = useMemo(() => snapshot === null ? [] : eligible
    .filter((entry) => checked.has(entry.fileId) && VersioningRevert.allows(entry) && !externalFileIds.has(entry.fileId)),
  [snapshot, eligible, checked, externalFileIds])
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
  const [messageOpen, setMessageOpen] = useState<boolean | null>(null)
  useEffect(() => { setMessageOpen(null) }, [draftId])
  const settingsRead = useRef(0)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const cancelled = draft?.phase.kind === 'cancelled'
  const busy = running || draft?.phase.kind === 'running' || draft?.externalReview === 'running' || cancelled
  const done = draft?.phase.kind === 'done'
  const close = useRef(props.onClose)
  close.current = props.onClose
  useEffect(() => { if (cancelled && !props.reviewOnly) close.current() }, [cancelled, draftId, props.reviewOnly])
  const cancelReview = async (): Promise<string | null> => {
    if (draft === null) return null
    if (ports.versioning.decideCommit && draft.epoch)
      return IpcFailure.of(await ports.versioning.decideCommit({ kind: 'cancel', draftId: draft.draftId, epoch: draft.epoch,
        expectedRevision: draft.revision, operationId: crypto.randomUUID() }))
    return ports.versioning.cancelCommit ? IpcFailure.of(await ports.versioning.cancelCommit(draft.draftId)) : null
  }
  // An empty review has nothing left to decide, yet closing its pane kept it pending: the agent's
  // `openwait` never returned and a main-copy Finish waited for that agent for good (058,
  // 2026-11-18). Closing it cancels it; a review Tortoise closed already has its outcome.
  const closeEmptyReview = (): void => {
    if (props.reviewOnly || draft === null || busy || done || draft.externalReview === 'closed') { close.current(); return }
    void cancelReview().then((refusal) => { if (refusal !== null) ports.reportError(`The empty commit review stays pending: ${refusal}`) },
      (error: unknown) => ports.reportError(`The empty commit review stays pending: ${String(error)}`))
      .finally(() => close.current())
  }
  const closeEmptyRef = useRef(closeEmptyReview)
  closeEmptyRef.current = closeEmptyReview
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
    closeEmptyRef.current()
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
  const closeView = (): void => { if (nothingToCommit) closeEmptyReview(); else props.onClose() }
  const checkedPaths = useMemo(() => JSON.stringify(selectedEntries
    .flatMap((entry) => entry.status === 'renamed' && entry.previousPath !== null ? [entry.path, entry.previousPath] : [entry.path])), [selectedEntries])
  const selectedIds = useMemo(() => JSON.stringify([...checked]), [checked])
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
  const separateMessages = props.repositoryMessages !== undefined
  const scopeRoot = draft?.scopeRoot ?? props.item.scopeRoot
  const scopeTooltip = draft?.scopeTooltip ?? props.item.scopeRoot
  const singleMessageOpen = messageOpen ?? true
  // Keep file-list callbacks referentially stable so typing in CommitMessageBox skips re-rendering CommitTargetsList.
  const listActions = useRef({ refreshDiffSettings, openExternal, setChecked, open, revert, openSeparate })
  listActions.current = { refreshDiffSettings, openExternal, setChecked, open, revert, openSeparate }
  const handleMenuOpen = useCallback(() => { void listActions.current.refreshDiffSettings() }, [])
  const handleOpenExternal = useCallback((entry: FileChangeEntry) => { void listActions.current.openExternal(entry) }, [])
  const handleCheckedChange = useCallback((ids: ReadonlySet<string>) => { listActions.current.setChecked(ids) }, [])
  const handleOpenEntry = useCallback((entry: FileChangeEntry) => { void listActions.current.open(entry) }, [])
  const handleRevertEntry = useCallback((entry: FileChangeEntry) => { void listActions.current.revert([entry.fileId]) }, [])
  const handleOpenSeparate = useCallback((root: string) => { void listActions.current.openSeparate(root) }, [])
  const filesNode = useMemo(() => done ? null : snapshot !== null
    ? <CommitTargetsList snapshot={snapshot} checked={checked} disabled={busy} separateMessages={separateMessages}
      repositoryMessages={props.repositoryMessages} scopeRoot={scopeRoot} scopeTooltip={scopeTooltip}
      onMenuOpen={handleMenuOpen} onOpenExternal={externalConfigured ? handleOpenExternal : null}
      onChange={handleCheckedChange} onOpen={handleOpenEntry} onRevert={handleRevertEntry} onOpenSeparately={handleOpenSeparate} />
    : <div className="commit-targets commit-targets--loading" aria-busy="true" />,
  [done, snapshot, checked, busy, separateMessages, props.repositoryMessages, scopeRoot, scopeTooltip, externalConfigured,
    handleMenuOpen, handleOpenExternal, handleCheckedChange, handleOpenEntry, handleRevertEntry, handleOpenSeparate])
  return <section className="commit-pane" tabIndex={-1} aria-label={`${props.item.vcs.toUpperCase()} commit dialog`}
    onKeyDownCapture={(event) => {
      if (props.reviewOnly) return
      if (event.nativeEvent.isComposing || event.repeat || event.altKey || event.ctrlKey || event.metaKey
        || (event.target instanceof Element && event.target.closest('[role="menu"]'))) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        if (!busy) closeView()
      } else if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        event.stopPropagation()
        if (canCommit) void run()
      }
    }}>
    {/* While loading or finished the targets bar is absent, so keep the scope line at the top. */}
    {(draft === null || snapshot === null || done) && <strong className="commit-scope" title={scopeTooltip}>{scopeRoot}</strong>}
    {draft !== null && (separateMessages ? filesNode : <CommitEditorLayout settings={ports.versioning} reportError={ports.reportError} files={filesNode}
      messageCollapsed={!singleMessageOpen}
      message={<CommitMessageBox value={draft.message} disabled={busy || done || snapshot === null || working.loading || working.requiredLoading} source={draft.messageSource ?? 'unknown'} findings={props.reviewOnly ? draft.messageFindings : undefined} proposed={draft.proposedByAgent && !draft.editedByPerson} reviewOnly={props.reviewOnly} expanded={singleMessageOpen} onExpandedChange={setMessageOpen} onChange={(value) => { if (messageOpen === null) setMessageOpen(true); model.setMessage(value) }} />} />)}
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
      <details><summary>Compare source message</summary>{!separateMessages
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
        <button type="button" disabled={busy} onClick={closeView}>Close view</button>
        {!done && draft !== null && (ports.versioning.cancelCommit || ports.versioning.decideCommit) && <button type="button" disabled={busy} onClick={() => {
          void cancelReview().then((refusal) => { setNote(refusal); model.refresh() })
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
