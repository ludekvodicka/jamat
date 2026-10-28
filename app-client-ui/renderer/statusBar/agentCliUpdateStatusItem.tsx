import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AgentCliUpdatesSnapshot } from '../../../lib-orchestrator/agentCliUpdates/agentCliUpdatesApi.types'
import type { IpcResult } from '../../shared/appClientUiIpc'
import { ErrorText } from '../../shared/errorText'
import { IpcFailure } from '../ipc/ipcFailure'
import { SnapshotStore, type SnapshotStorePorts } from '../ipc/snapshotStore'
import { useSnapshotStore } from '../views/sessionsTree/useSessionsSnapshot'
import './agentCliUpdateStatusItem.css'

export interface AgentCliUpdatePorts extends SnapshotStorePorts<AgentCliUpdatesSnapshot> {
  check(): Promise<IpcResult<void>>
  install(id: string): Promise<IpcResult<void>>
}

export function AgentCliUpdateStatusItem({ ports }: { ports: AgentCliUpdatePorts }): React.JSX.Element {
  const store = useMemo(() => new SnapshotStore('CLI updates', ports), [ports])
  useEffect(() => store.start(), [store])
  const { snapshot, error } = useSnapshotStore(store)
  const [open, setOpen] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const operation = useRef(false)
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement
    dialog.current?.focus()
    return () => { if (previous instanceof HTMLElement) previous.focus() }
  }, [open])
  const agents = snapshot?.agents ?? []
  const available = agents.filter(row => row.available).length
  const updating = agents.some(row => row.activity === 'updating')
  const checking = agents.some(row => row.activity === 'checking')
  const failed = !!error || agents.some(row => row.error !== null)
  const busy = pending || updating || checking
  const label = updating ? 'CLI updating…' : available ? `CLI: ${available} update${available === 1 ? '' : 's'}`
    : checking ? 'CLI checking…' : failed ? 'CLI: check failed' : 'CLI updates'
  const run = async (action: () => Promise<IpcResult<void>>): Promise<void> => {
    if (operation.current) return
    operation.current = true
    setPending(true)
    setProblem(null)
    try { IpcFailure.unwrap(await action()) }
    catch (error) { setProblem(ErrorText.of(error)) }
    finally { operation.current = false; setPending(false); store.refresh() }
  }
  return <>
    <button ref={trigger} className={`jamat-cli-updates__indicator${available ? ' is-available' : ''}`}
      type="button" aria-haspopup="dialog" title="Agent CLI updates on this computer" onClick={() => setOpen(true)}>{label}</button>
    {open && createPortal(<div className="jamat-cli-updates" onMouseDown={event => {
      if (event.target === event.currentTarget) setOpen(false)
    }}>
      <div ref={dialog} className="jamat-cli-updates__panel" role="dialog" aria-modal="true" aria-label="Agent CLI updates" tabIndex={-1}
        onKeyDown={event => {
          event.stopPropagation()
          if (event.key === 'Escape') { event.preventDefault(); setOpen(false) }
          else if (event.key === 'Tab') {
            const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), summary')]
            if (controls.length) {
              event.preventDefault()
              const index = controls.indexOf(document.activeElement as HTMLElement)
              controls[(index + (event.shiftKey ? controls.length - 1 : 1)) % controls.length]?.focus()
            }
          }
        }}>
        <header><h2>Agent CLI updates</h2><button type="button" onClick={() => setOpen(false)} aria-label="Close CLI updates">Close</button></header>
        <p>Checks run every hour on this computer. Updates start only when you click Update. Running sessions keep their current version.</p>
        {(problem || error) && <p role="alert">{problem || error}</p>}
        {snapshot === null && !error && <p>Reading CLI update status…</p>}
        {agents.map(row => <section key={row.id} aria-label={row.label}>
          <header><h3>{row.label}</h3><button type="button" disabled={busy || !row.available || !row.canUpdate}
            onClick={() => void run(() => ports.install(row.id))}>
            {row.activity === 'updating' ? 'Updating…' : `Update ${row.label}`}</button></header>
          <p>Installed: {row.installedVersion ?? 'Not detected'} · Available: {row.latestVersion ?? 'Not checked'}{row.channel && ` · Channel: ${row.channel}`}</p>
          {row.path && <p className="jamat-cli-updates__path">{row.path}</p>}
          {row.checkedAt !== null && <p>Last checked: {new Date(row.checkedAt).toLocaleString()}</p>}
          {row.detail && <p>{row.detail}</p>}
          {row.error && <p role="alert">{row.error}</p>}
          {row.output && <details open><summary>Update output</summary><pre>{row.output}</pre></details>}
        </section>)}
        <footer><button type="button" disabled={busy} onClick={() => void run(() => ports.check())}>{checking ? 'Checking…' : 'Check now'}</button></footer>
      </div>
    </div>, document.body)}
  </>
}
