import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import type { AgentMemoryListing } from '../../../../lib-orchestrator/agentMemory/agentMemoryApi.types'
import type { AgentMemoryTarget } from '../../../../lib-orchestrator/clientApi/appOperationMap'
import { ErrorText } from '../../../shared/errorText'
import { FileViewerMarkdown } from '../../fileViewer/fileViewerContent'
import { AppControl } from '../../ipc/appControl'
import '../sessionDetails/sessionDetails.css'
import './agentMemoryDialog.css'

/** A session whose memory the Session memory tab can show. */
export interface AgentMemorySession {
  key: string
  label: string
  target: AgentMemoryTarget
}

interface MemorySource {
  key: string
  /** Drawn above the source's files; empty when the source is the only one. */
  label: string
  target: AgentMemoryTarget
}

interface OpenFile {
  name: string
  text: string
  modifiedAt: number
}

type MemoryTab = 'session' | 'global'

/** Module constants: the browser reloads whenever its sources change identity. */
const globalSourcesConst: readonly MemorySource[] = [
  { key: 'claude', label: 'Claude', target: { scope: 'user', agentId: 'claude' } },
  { key: 'codex', label: 'Codex', target: { scope: 'user', agentId: 'codex' } },
  { key: 'antigravity', label: 'Antigravity', target: { scope: 'user', agentId: 'antigravity' } },
]

/**
 * Tools > Memory files. Session memory: the memory an agent keeps for the chosen session's project,
 * with the files its conversation wrote marked, which is what a person checks around pruning a
 * private session. Global memory: each agent's user-level files, read in every project.
 */
export function AgentMemoryDialog(props: {
  sessions: readonly AgentMemorySession[]
  /** The session the Session memory tab opens on; the first one when absent from the list. */
  initialSession: string | null
  onClose(): void
}): React.JSX.Element {
  const [tab, setTab] = useState<MemoryTab>('session')
  // Taken when the dialog opens: a list that changed identity on every render would reload the files.
  const [sessions] = useState(props.sessions)
  const [sessionKey, setSessionKey] = useState(() =>
    sessions.find((one) => one.key === props.initialSession)?.key ?? sessions[0]?.key ?? null)
  const [busy, setBusy] = useState(false)
  const card = useRef<HTMLDivElement>(null)
  useEffect(() => { card.current?.focus() }, [])
  const session = sessions.find((one) => one.key === sessionKey) ?? null
  const sessionSources = useMemo<readonly MemorySource[]>(() =>
    session === null ? [] : [{ key: 'session', label: '', target: session.target }], [session])
  const close = (): void => { if (!busy) props.onClose() }

  return createPortal(<div className="jamat-session-details jamat-agent-memory-layer" onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}>
    <div className="jamat-session-details__card jamat-agent-memory" role="dialog" aria-modal="true" aria-label="Memory files"
      tabIndex={-1} ref={card} onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key !== 'Escape') return
        event.preventDefault()
        close()
      }}>
      <header className="jamat-session-details__head">
        <span className="jamat-session-details__title">Memory files</span>
        <button className="jamat-session-details__close" type="button" aria-label="Close Memory files" disabled={busy} onClick={close}>×</button>
      </header>
      <div className="jamat-agent-memory__tabs" role="tablist" aria-label="Memory">
        {([['session', 'Session memory'], ['global', 'Global memory']] as const).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} disabled={busy}
            className={`jamat-agent-memory__tab${tab === id ? ' jamat-agent-memory__tab--selected' : ''}`}
            onClick={() => setTab(id)}>{label}</button>
        ))}
        {tab === 'session' && sessions.length > 0 && <select className="jamat-agent-memory__session" aria-label="Session"
          value={sessionKey ?? ''} disabled={busy} onChange={(event) => setSessionKey(event.target.value)}>
          {sessions.map((one) => <option key={one.key} value={one.key}>{one.label}</option>)}
        </select>}
      </div>
      {tab === 'session'
        ? session === null
          ? <p className="jamat-agent-memory__empty">No local agent session to show the memory of.</p>
          : <MemoryBrowser key={`session:${session.key}`} sources={sessionSources} onBusy={setBusy} />
        : <MemoryBrowser key="global" sources={globalSourcesConst} onBusy={setBusy} />}
    </div>
  </div>, document.body)
}

/** The files of one or more memory folders on the left, the chosen file on the right. */
function MemoryBrowser(props: { sources: readonly MemorySource[]; onBusy(busy: boolean): void }): React.JSX.Element {
  const [listings, setListings] = useState<Readonly<Record<string, AgentMemoryListing>>>({})
  const [selected, setSelected] = useState<{ source: string; name: string } | null>(null)
  const [file, setFile] = useState<OpenFile | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [busy, setBusyState] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const active = useRef(true)
  const { sources, onBusy } = props
  const setBusy = useCallback((value: boolean) => { setBusyState(value); onBusy(value) }, [onBusy])

  useEffect(() => {
    active.current = true
    return () => { active.current = false; onBusy(false) }
  }, [onBusy])

  const targetOf = useCallback((key: string): AgentMemoryTarget => {
    const source = sources.find((one) => one.key === key)
    if (source === undefined) throw new Error(`Unknown memory source: ${JSON.stringify(key)}`)
    return source.target
  }, [sources])

  const load = useCallback(async (keep: { source: string; name: string } | null): Promise<void> => {
    const answers = await Promise.all(sources.map(async (source) =>
      [source.key, await AppControl.value('agentMemory.list', { target: source.target })] as const))
    if (!active.current) return
    const loaded: Record<string, AgentMemoryListing> = {}
    for (const [key, answer] of answers)
      if (answer.ok) loaded[key] = answer.value
      else setProblem(answer.error)
    setListings(loaded)
    const has = (pick: { source: string; name: string } | null): boolean => pick !== null
      && (loaded[pick.source]?.files.some((one) => one.name === pick.name) ?? false)
    const first = sources.flatMap((source) => (loaded[source.key]?.files ?? []).map((one) => ({ source: source.key, name: one.name })))[0] ?? null
    setSelected(has(keep) ? keep : first)
  }, [sources])

  useEffect(() => { void load(null).catch((error: unknown) => setProblem(ErrorText.of(error))) }, [load])

  useEffect(() => {
    setFile(null)
    setDraft(null)
    setDeleting(false)
    if (selected === null) return
    let current = true
    void AppControl.value('agentMemory.read', { target: targetOf(selected.source), name: selected.name }).then((answer) => {
      if (!current || !active.current) return
      if (answer.ok) setFile(answer.value)
      else setProblem(answer.error)
    }).catch((error: unknown) => { if (current) setProblem(ErrorText.of(error)) })
    return () => { current = false }
  }, [selected, targetOf])

  const run = async (work: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(true)
    setProblem(null)
    setNotice(null)
    try { await work() }
    catch (error) { if (active.current) setProblem(ErrorText.of(error)) }
    finally { if (active.current) setBusy(false) }
  }
  const save = (): Promise<void> => run(async () => {
    if (file === null || draft === null || selected === null) return
    const answer = await AppControl.value('agentMemory.write',
      { target: targetOf(selected.source), name: file.name, text: draft, expectedModifiedAt: file.modifiedAt })
    if (!answer.ok) throw new Error(answer.error)
    if (!active.current) return
    setFile({ ...file, text: draft, modifiedAt: answer.value.modifiedAt })
    setDraft(null)
    setNotice(`${file.name} saved`)
    await load(selected)
  })
  const remove = (): Promise<void> => run(async () => {
    if (file === null || selected === null) return
    const answer = await AppControl.value('agentMemory.delete', { target: targetOf(selected.source), name: file.name })
    if (!answer.ok) throw new Error(answer.error)
    if (!active.current) return
    const lines = answer.value.indexLinesRemoved
    setNotice(`${file.name} deleted${lines > 0 ? `; ${lines} line(s) of MEMORY.md that linked to it went too` : ''}`)
    await load(null)
  })
  const openLink = (reference: string): void => {
    const name = reference.replace(/^\.\//, '').split('#')[0]
    if (selected !== null && listings[selected.source]?.files.some((one) => one.name === name))
      setSelected({ source: selected.source, name })
  }
  const shown = listings[selected?.source ?? sources[0].key] ?? null
  const loaded = sources.every((source) => listings[source.key] !== undefined)
  const written = Object.values(listings).reduce((sum, listing) => sum + listing.files.filter((one) => one.writtenByConversation).length, 0)

  return <div className="jamat-agent-memory__browser" onKeyDown={(event) => {
    if (event.key !== 'Escape' || (draft === null && !deleting)) return
    event.preventDefault()
    event.stopPropagation()
    if (draft !== null) setDraft(null)
    else setDeleting(false)
  }}>
    <div className="jamat-agent-memory__path" title={shown?.directory}>
      {shown === null ? loaded ? '' : 'Loading…' : `${shown.directory}${AgentMemoryNotes.scopeOf(shown.scope)}`}
      {written > 0 && <span className="jamat-agent-memory__legend"> · ✎ written by this session: {written}</span>}
    </div>
    <div className="jamat-agent-memory__body">
      <ul className="jamat-agent-memory__list" aria-label="Memory files">
        {sources.map((source) => {
          const listing = listings[source.key]
          const files = listing?.files ?? []
          return [
            source.label !== '' && <li key={`${source.key}:head`} className="jamat-agent-memory__group" title={listing?.directory}>{source.label}</li>,
            ...files.map((one) => {
              const chosen = selected?.source === source.key && selected.name === one.name
              return <li key={`${source.key}:${one.name}`}>
                <button type="button" aria-current={chosen} disabled={busy || draft !== null}
                  className={`jamat-agent-memory__item${chosen ? ' jamat-agent-memory__item--selected' : ''}`}
                  title={`${one.name}\n${new Date(one.modifiedAt).toLocaleString()} · ${one.size} B${one.writtenByConversation ? '\nWritten by this session' : ''}`}
                  onClick={() => setSelected({ source: source.key, name: one.name })}>
                  <span className="jamat-agent-memory__name">{one.name}</span>
                  {one.writtenByConversation && <span className="jamat-agent-memory__mark" aria-label="written by this session">✎</span>}
                </button>
              </li>
            }),
            listing !== undefined && files.length === 0 && <li key={`${source.key}:empty`} className="jamat-agent-memory__empty">No memory files.</li>,
            listing?.truncated === true && <li key={`${source.key}:more`} className="jamat-agent-memory__empty">More files exist than are listed.</li>,
          ]
        })}
      </ul>
      <section className="jamat-agent-memory__view" aria-label="Memory file">
        {file !== null && <div className="jamat-agent-memory__toolbar">
          <span className="jamat-agent-memory__file">{file.name}</span>
          {draft === null && !deleting && <>
            <button className="jamat-session-details__button" type="button" disabled={busy} onClick={() => setDraft(file.text)}>Edit</button>
            <button className="jamat-session-details__button" type="button" disabled={busy} onClick={() => setDeleting(true)}>Delete</button>
          </>}
          {draft !== null && <>
            <button className="jamat-session-details__button jamat-session-details__button--primary" type="button"
              disabled={busy || draft === file.text} onClick={() => void save()}>Save</button>
            <button className="jamat-session-details__button" type="button" disabled={busy} onClick={() => setDraft(null)}>Cancel</button>
          </>}
          {deleting && <>
            <span className="jamat-agent-memory__confirm">Delete {file.name}?</span>
            <button className="jamat-session-details__button jamat-agent-memory__danger" type="button" disabled={busy} onClick={() => void remove()}>Delete</button>
            <button className="jamat-session-details__button" type="button" disabled={busy} onClick={() => setDeleting(false)}>Cancel</button>
          </>}
        </div>}
        {problem !== null && <p className="jamat-session-details__error" role="alert">{problem}</p>}
        {notice !== null && <p className="jamat-agent-memory__notice" role="status">{notice}</p>}
        <div className="jamat-agent-memory__content">
          {file === null ? <p className="jamat-agent-memory__empty">{selected === null ? 'Nothing to show.' : 'Loading…'}</p>
            : draft !== null ? <textarea aria-label={`Edit ${file.name}`} autoFocus value={draft} disabled={busy}
              onChange={(event) => setDraft(event.target.value)} />
            : file.name.toLowerCase().endsWith('.md') ? <FileViewerMarkdown source={file.text} onLink={openLink} />
            : <pre>{file.text}</pre>}
        </div>
      </section>
    </div>
  </div>
}

class AgentMemoryNotes {
  static scopeOf(scope: AgentMemoryListing['scope']): string {
    if (scope === 'project') return ''
    else if (scope === 'global') return ' (shared by every project)'
    else if (scope === 'user') return ' (user-level files, read in every project)'
    else throw new Error(`Unknown memory scope: ${JSON.stringify(scope)}`)
  }
}
