import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { FileChangeEntry } from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import { VersioningSettings } from '../../shared/versioningSettings'
import { VersioningRevert } from '../../shared/versioningCommit'
import type { FileViewerChangedOpen } from '../fileViewer/fileViewerPanel.types'
import { useWorkingTreeChanges } from '../fileViewer/useWorkingTreeChanges'
import { IpcFailure } from '../ipc/ipcFailure'
import type { PanelSplitCommitItem } from '../widgets/tabs/panelSplit'
import { CommitMessageBox } from './commitMessageBox'
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
  const [selection, setSelection] = useState<ReadonlyMap<string, boolean>>(new Map())
  const checked = new Set(snapshot === null ? [] : CommitTargets.eligible(snapshot)
    .filter((entry) => selection.get(entry.path) ?? true).map((entry) => entry.fileId))
  const selectedCount = snapshot === null ? 0 : CommitTargets.selected(CommitTargets.eligible(snapshot), checked).length
  const revertible = snapshot === null ? [] : CommitTargets.eligible(snapshot)
    .filter((entry) => checked.has(entry.fileId) && VersioningRevert.allows(entry))
  const setChecked = (ids: ReadonlySet<string>): void => {
    if (snapshot === null) return
    setSelection(new Map(snapshot.entries.map((entry) => [entry.path, ids.has(entry.fileId)])))
  }
  const [note, setNote] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [opening, setOpening] = useState(false)
  const [externalConfigured, setExternalConfigured] = useState(false)
  const settingsRead = useRef(0)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const busy = running || draft?.phase.kind === 'running'
  const done = draft?.phase.kind === 'done'
  const canCommit = !busy && !done && !working.loading && snapshot !== null && checked.size > 0 && !!draft?.message.trim()
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
      if (!answer.ok || !answer.value.ok || answer.value.reverted) await working.reload()
    } finally { if (mounted.current) setRunning(false) }
  }
  const open = async (entry: FileChangeEntry): Promise<void> => {
    if (snapshot === null || opening || busy || done || entry.nodeKind !== 'file') return
    setOpening(true)
    try {
      const answer = await ports.openFile(snapshot.snapshotId, entry.fileId)
      const refusal = IpcFailure.of(answer)
      if (refusal !== null) { if (mounted.current) setNote(refusal); return }
      if (!answer.ok || !answer.value.ok) return
      try {
        if (!mounted.current) return
        const baseline = snapshot.defaultBaseline
        setNote(props.onOpenChanged({ document: answer.value.value, snapshot, fileId: entry.fileId,
          baselineHint: baseline === null || snapshot.source.selected === null ? null
            : { kind: baseline.kind, revision: baseline.revision, workingTreeSource: snapshot.source.selected } }))
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
    setNote(null)
    try {
      const answer = await ports.versioning.runCommit({ draftId: draft.draftId, snapshotId: snapshot.snapshotId, fileIds: [...checked], message: draft.message })
      if (!mounted.current) return
      setNote(IpcFailure.of(answer))
      model.refresh()
    } finally { if (mounted.current) setRunning(false) }
  }
  const openTortoise = async (): Promise<void> => {
    if (draft === null || busy || done) return
    setRunning(true)
    setNote('Tortoise is open. Close its dialog to refresh this list.')
    try {
      const answer = await ports.versioning.openTortoise(draft.draftId, draft.message)
      if (!mounted.current) return
      setNote(IpcFailure.of(answer))
      await working.reload()
    } finally { if (mounted.current) setRunning(false) }
  }
  const phase = draft?.phase
  let status: string | null = null
  if (phase === undefined || phase.kind === 'editing') status = null
  else if (phase.kind === 'running') status = 'Committing...'
  else if (phase.kind === 'done') status = `Committed ${phase.revision}\n${phase.output}`
  else if (phase.kind === 'failed') status = phase.detail
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
    <strong className="commit-scope">{draft?.scopeDisplay ?? props.item.scopeRoot}</strong>
    {snapshot !== null && !done && <CommitTargetsList snapshot={snapshot} checked={checked} disabled={busy}
      onMenuOpen={() => { void refreshDiffSettings() }} onOpenExternal={externalConfigured ? (entry) => { void openExternal(entry) } : null}
      onChange={setChecked} onOpen={(entry) => { void open(entry) }} onRevert={(entry) => { void revert([entry.fileId]) }} onOpenSeparately={props.onOpenSeparately} />}
    {draft !== null && <CommitMessageBox value={draft.message} disabled={busy || done} proposed={draft.proposedByAgent && !draft.editedByPerson} onChange={model.setMessage} />}
    <div role="status" className="commit-status">
      {model.error ?? working.error ?? working.requiredError ?? note ?? status
        ?? (working.loading && draft !== null ? 'Reading changes...' : draft === null ? 'Opening commit dialog...' : `${selectedCount} selected`)}
    </div>
    {snapshot?.warnings.map((warning) => <p className="commit-warning" key={warning}>{warning}</p>)}
    <div className="commit-actions">
      <div className="commit-actions-left">
        {!done && draft !== null && <button type="button" disabled={busy || working.loading} onClick={() => { setNote(null); void working.reload() }}>Reload</button>}
        {!done && draft !== null && <button type="button" disabled={busy || working.loading || revertible.length === 0}
          title="Revert checked modified, missing or deleted files. Added files, folders, moves and conflicts are excluded."
          onClick={() => { void revert(revertible.map((entry) => entry.fileId)) }}>Revert selected ({revertible.length})…</button>}
        {!done && draft !== null && <button type="button" disabled={busy}
          title={`Open this folder in the Tortoise${draft.vcs === 'svn' ? 'SVN' : 'Git'} commit dialog with the current message`}
          onClick={() => { void openTortoise() }}>Open in Tortoise</button>}
      </div>
      <div className="commit-actions-right">
        {!done && draft !== null && <button type="button" className="commit-submit" disabled={!canCommit} onClick={() => { void run() }}>OK</button>}
        <button type="button" disabled={busy} onClick={props.onClose}>{done || model.error !== null ? 'Close' : 'Cancel'}</button>
      </div>
    </div>
  </section>
}
