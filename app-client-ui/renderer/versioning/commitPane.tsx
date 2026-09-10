import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { FileChangeEntry } from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import type { FileViewerChangedOpen } from '../fileViewer/fileViewerPanel.types'
import { useWorkingTreeChanges } from '../fileViewer/useWorkingTreeChanges'
import { IpcFailure } from '../ipc/ipcFailure'
import type { PanelSplitCommitItem } from '../widgets/tabs/panelSplit'
import { CommitMessageBox } from './commitMessageBox'
import { CommitPaneBridge, type CommitPanePorts } from './commitPanePorts'
import { CommitTargets, CommitTargetsTree } from './commitTargetsTree'
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
  const setChecked = (ids: ReadonlySet<string>): void => {
    if (snapshot === null) return
    setSelection(new Map(snapshot.entries.map((entry) => [entry.path, ids.has(entry.fileId)])))
  }
  const [note, setNote] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [opening, setOpening] = useState(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const busy = running || draft?.phase.kind === 'running'
  const done = draft?.phase.kind === 'done'
  const open = async (entry: FileChangeEntry): Promise<void> => {
    if (snapshot === null || opening || entry.nodeKind !== 'file') return
    setOpening(true)
    try {
      const settings = await ports.versioning.getSettings()
      if (!settings.ok) { if (mounted.current) setNote(settings.error); return }
      const tool = settings.value.diffTool
      if (tool.kind === 'external') {
        const baseline = snapshot.defaultBaseline
        if (baseline === null) { setNote('There is no baseline for this file'); return }
        const answer = await ports.versioning.externalDiff({ snapshotId: snapshot.snapshotId, fileId: entry.fileId, baselineId: baseline.baselineId })
        if (mounted.current) setNote(!answer.ok ? answer.error : !answer.value.ok ? answer.value.detail : null)
        return
      } else if (tool.kind !== 'internal') throw new Error(`Unknown diff tool: ${JSON.stringify(tool)}`)
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
  const run = async (): Promise<void> => {
    if (draft === null || snapshot === null || busy || checked.size === 0) return
    setRunning(true)
    setNote(null)
    try {
      const answer = await ports.versioning.runCommit({ draftId: draft.draftId, snapshotId: snapshot.snapshotId, fileIds: [...checked], message: draft.message })
      if (!mounted.current) return
      setNote(IpcFailure.of(answer))
      model.refresh()
    } finally { if (mounted.current) setRunning(false) }
  }
  const phase = draft?.phase
  let status: string | null = null
  if (phase === undefined || phase.kind === 'editing') status = null
  else if (phase.kind === 'running') status = 'Committing...'
  else if (phase.kind === 'done') status = `Committed ${phase.revision}\n${phase.output}`
  else if (phase.kind === 'failed') status = phase.detail
  else throw new Error(`Unknown commit phase: ${JSON.stringify(phase)}`)
  return <section className="commit-pane" aria-label={`${props.item.vcs.toUpperCase()} commit dialog`}>
    <strong className="commit-scope">{draft?.scopeDisplay ?? props.item.scopeRoot}</strong>
    {snapshot !== null && !done && <CommitTargetsTree snapshot={snapshot} checked={checked} disabled={busy}
      onChange={setChecked} onOpen={(entry) => { void open(entry) }} onOpenSeparately={props.onOpenSeparately} />}
    {draft !== null && <CommitMessageBox value={draft.message} disabled={busy || done} proposed={draft.proposedByAgent && !draft.editedByPerson} onChange={model.setMessage} />}
    <div role="status" className="commit-status">
      {model.error ?? working.error ?? working.requiredError ?? note ?? status
        ?? (working.loading && draft !== null ? 'Reading changes...' : draft === null ? 'Opening commit dialog...' : `${checked.size} selected`)}
    </div>
    {snapshot?.warnings.map((warning) => <p className="commit-warning" key={warning}>{warning}</p>)}
    <div className="commit-actions">
      {!done && draft !== null && <button type="button" disabled={busy || working.loading} onClick={() => { setNote(null); void working.reload() }}>Reload</button>}
      {!done && draft !== null && <button type="button" className="commit-submit" disabled={busy || working.loading || snapshot === null || checked.size === 0 || !draft.message.trim()} onClick={() => { void run() }}>OK</button>}
      <button type="button" disabled={busy} onClick={props.onClose}>{done || model.error !== null ? 'Close' : 'Cancel'}</button>
    </div>
  </section>
}
