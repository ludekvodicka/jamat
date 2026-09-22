import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { FileChangeEntry } from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import { VersioningSettings } from '../../shared/versioningSettings'
import { VersioningRevert } from '../../shared/versioningCommit'
import type { FileViewerChangedOpen } from '../fileViewer/fileViewerPanel.types'
import { FileChangesOpen } from '../fileViewer/fileChangesOpen'
import { useWorkingTreeChanges } from '../fileViewer/useWorkingTreeChanges'
import { IpcFailure } from '../ipc/ipcFailure'
import type { PanelSplitCommitItem } from '../widgets/tabs/panelSplit'
import { CommitEditorLayout } from './commitEditorLayout'
import { CommitMessageBox } from './commitMessageBox'
import { CommitProgress } from './commitProgress'
import { CommitPaneBridge, type CommitPanePorts } from './commitPanePorts'
import { CommitTargets, CommitTargetsList } from './commitTargetsList'
import { useCommitDraft } from './useCommitDraft'
import './commitPane.css'

export function CommitPane(props: {
  sessionId: string
  item: PanelSplitCommitItem
  ports?: CommitPanePorts
  onClose(): void
  onOpenChanged(value: FileViewerChangedOpen): string | null
  onOpenSeparately(scopeRoot: string): void
}): React.JSX.Element {
  const ports = useMemo(() => props.ports ?? CommitPaneBridge.of(), [props.ports])
  const model = useCommitDraft(props.sessionId, props.item, ports)
  const draft = model.draft
  const draftId = draft?.draftId
  const read = useCallback(() => ports.versioning.commitFiles(draftId ?? ''), [ports, draftId])
  const working = useWorkingTreeChanges(props.sessionId, draft !== null, draft?.source, read)
  useEffect(() => { if (draft !== null) working.select(draft.source) }, [draft?.source])
  const snapshot = draft === null ? null : working.snapshotFor(draft.source)
  const latestSnapshot = useRef(snapshot)
  useEffect(() => { latestSnapshot.current = snapshot }, [snapshot])
  const [selection, setSelection] = useState<ReadonlyMap<string, boolean>>(new Map())
  const checked = new Set(snapshot === null ? [] : CommitTargets.eligible(snapshot)
    .filter((entry) => selection.get(entry.path) ?? true).map((entry) => entry.fileId))
  const selectedCount = snapshot === null ? 0 : CommitTargets.selected(CommitTargets.eligible(snapshot), checked).length
  const revertible = snapshot === null ? [] : CommitTargets.eligible(snapshot)
    .filter((entry) => checked.has(entry.fileId) && VersioningRevert.allows(entry)
      && !snapshot.externalRoots.some((root) => root.fileIds.includes(entry.fileId)))
  const setChecked = (ids: ReadonlySet<string>): void => {
    if (snapshot === null) return
    setSelection(new Map(snapshot.entries.map((entry) => [entry.path, ids.has(entry.fileId)])))
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
  const busy = running || draft?.phase.kind === 'running' || cancelled
  const done = draft?.phase.kind === 'done'
  const close = useRef(props.onClose)
  close.current = props.onClose
  useEffect(() => { if (cancelled) close.current() }, [cancelled, draftId])
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
    if (!closeEmpty || busy || done || snapshot.warnings.length > 0 || populatedDraft.current !== draftId) return
    populatedDraft.current = null
    close.current()
  }, [draftId, snapshot, closeEmpty, busy, done, working.loading, working.requiredLoading,
    working.error, working.requiredError, model.error])
  useEffect(() => {
    const completed = draft?.phase
    if (completed?.kind !== 'done') return
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
  }, [done, draftId, ports])
  const canCommit = !busy && !done && !working.loading && !working.requiredLoading
    && working.error === null && working.requiredError === null && snapshot !== null && checked.size > 0 && !!draft?.message.trim()
  const refreshDiffSettings = async (): Promise<void> => {
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
      const answer = await ports.versioning.revertCommitFile({ draftId: draft.draftId, snapshotId: snapshot.snapshotId, fileIds })
      if (!mounted.current) return
      setNote(IpcFailure.of(answer))
      if (!answer.ok || !answer.value.ok || answer.value.reverted) await reload(answer.ok && answer.value.ok)
    } finally { if (mounted.current) setRunning(false) }
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
      const answer = await ports.versioning.externalDiff({ snapshotId: snapshot.snapshotId, fileId: entry.fileId, baselineId: baseline.baselineId })
      if (mounted.current) setNote(!answer.ok ? answer.error : !answer.value.ok ? answer.value.detail : null)
    } finally { if (mounted.current) setOpening(false) }
  }
  const run = async (): Promise<void> => {
    if (draft === null || snapshot === null || !canCommit) return
    setRunning(true)
    setCommitStartedAt(Date.now())
    setNote(null)
    try {
      const answer = await ports.versioning.runCommit({ draftId: draft.draftId, snapshotId: snapshot.snapshotId, fileIds: [...checked], message: draft.message,
        ...(draft.vcs === 'svn' ? { includeExternals: true } : {}) })
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
  const openTortoise = async (): Promise<void> => {
    if (draft === null || busy || done) return
    setRunning(true)
    setNote('Tortoise is open. Close its dialog to refresh this list.')
    try {
      const answer = await ports.versioning.openTortoise(draft.draftId, draft.message)
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
  return <section className="commit-pane" tabIndex={-1} aria-label={`${props.item.vcs.toUpperCase()} commit dialog`}
    onKeyDownCapture={(event) => {
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
    {draft !== null && <CommitEditorLayout settings={ports.versioning} reportError={ports.reportError} files={snapshot !== null && !done ? <CommitTargetsList snapshot={snapshot} checked={checked} disabled={busy}
      onMenuOpen={() => { void refreshDiffSettings() }} onOpenExternal={externalConfigured ? (entry) => { void openExternal(entry) } : null}
      onChange={setChecked} onOpen={(entry) => { void open(entry) }} onRevert={(entry) => { void revert([entry.fileId]) }} onOpenSeparately={props.onOpenSeparately} /> : null}
      message={<CommitMessageBox value={draft.message} disabled={busy || done} proposed={draft.proposedByAgent && !draft.editedByPerson} onChange={model.setMessage} />} />}
    {phase?.kind === 'running' ? <CommitProgress phase={phase} />
      : commitStartedAt !== null && !done
        ? <CommitProgress phase={{ kind: 'running', startedAt: commitStartedAt }} /> : null}
    <div role="status" className="commit-status">
      {model.error ?? working.error ?? working.requiredError ?? note ?? status
        ?? (working.loading && draft !== null ? 'Reading changes...' : draft === null ? 'Opening commit dialog...' : `${selectedCount} selected`)}
    </div>
    {snapshot?.warnings.map((warning) => <p className="commit-warning" key={warning}>{warning}</p>)}
    <div className="commit-actions">
      <div className="commit-actions-left">
        {!done && draft !== null && <button type="button" className="commit-submit" disabled={!canCommit} onClick={() => { void run() }}>Commit files</button>}
        <button type="button" disabled={busy} onClick={props.onClose}>{done || model.error !== null ? 'Close' : 'Cancel'}</button>
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
    </div>
  </section>
}
