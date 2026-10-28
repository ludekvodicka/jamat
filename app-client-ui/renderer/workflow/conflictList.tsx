import { useState } from 'react'

import type {
  SessionSvnConflictInfo,
  SessionSvnConflictOptionInfo,
  SvnConflictWireActor,
  SvnConflictState,
} from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { SvnConflictKind, SvnConflictOption } from '../../../lib-orchestrator/svn/svn.types'

/** What a row does; each answers the refusal the row shows, or null. */
export interface ConflictListPorts {
  editorUnavailable?: string
  /**
   * One option on the path; `confirm` only after the person confirmed a loss of incoming work, never for Take incoming.
   * `kind` only where the path holds a text and a property conflict, each its own row.
   */
  resolve(path: string, option: SvnConflictOption, confirm: boolean, kind?: SvnConflictKind): Promise<string | null>
  /** The worktree file in a further inner tab, beside the workflow item. */
  openFile(path: string): Promise<string | null>
  /** TortoiseSVN's conflict editor for the path. */
  openConflictEditor(path: string): Promise<string | null>
  /** The merger's brief of the set in a further inner tab. */
  openBrief(): Promise<string | null>
}

type ConflictGroupId = 'fixed' | 'agent' | 'person'

interface ConflictGroup {
  id: ConflictGroupId
  title: string
  entries: SessionSvnConflictInfo[]
}

/**
 * The conflict set of an action inside its "Conflicts" step: the summary, then the paths grouped by
 * who works on them. Every sentence is the library's (`SessionSvnActionInfo.summary`, each entry's
 * description); the list only groups by `state` and draws. Each open row offers the options its entry
 * admits, with the library's labels and notes; an option that loses either side (Keep mine the incoming
 * work, Take incoming the session's own changes) shows its note as a warning on the first click and
 * runs only on the second, and any other click disarms it. Only a loss of incoming work carries the
 * wire's confirmation.
 * Each row also opens its path in the viewer or in TortoiseSVN's conflict editor, and shows the
 * refusal of the last thing it ran while the row keeps the state it had then. A settled row moves to
 * Fixed with the next snapshot, without the failure of an option chosen before it settled.
 */
export function ConflictList(props: {
  ref?: React.Ref<HTMLElement>
  summary: string
  conflicts: { entries: readonly SessionSvnConflictInfo[]; more: number }
  /** The merger's brief of the set; absent or null while there is none. */
  mergeBrief?: string | null
  ports: ConflictListPorts
}): React.JSX.Element {
  const { more } = props.conflicts
  const [notes, setNotes] = useState<ReadonlyMap<string, { text: string; state: SvnConflictState }>>(new Map())
  const [armed, setArmed] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [briefRefusal, setBriefRefusal] = useState<string | null>(null)
  const run = (entry: SessionSvnConflictInfo, work: () => Promise<string | null>): void => {
    const row = ConflictOptions.rowOf(entry)
    void work().then((refusal) => setNotes((current) => {
      const next = new Map(current)
      if (refusal === null) next.delete(row)
      else next.set(row, { text: refusal, state: entry.state })
      return next
    }))
  }
  const noteOf = (entry: SessionSvnConflictInfo): string | null => {
    const note = notes.get(ConflictOptions.rowOf(entry))
    return note === undefined || note.state !== entry.state ? null : note.text
  }
  const named = (entry: SessionSvnConflictInfo): boolean => props.conflicts.entries.some((other) => other !== entry && other.path === entry.path)
  const press = (entry: SessionSvnConflictInfo, option: SessionSvnConflictOptionInfo): void => {
    const row = ConflictOptions.rowOf(entry)
    const key = ConflictOptions.keyOf(row, option.id)
    if (option.loses !== 'nothing' && armed !== key) {
      setArmed(key)
      return
    }
    setArmed(null)
    setBusy(row)
    const confirm = option.loses === 'incoming'
    const settled = named(entry) ? props.ports.resolve(entry.path, option.id, confirm, entry.kind) : props.ports.resolve(entry.path, option.id, confirm)
    run(entry, () => settled.finally(() => setBusy(null)))
  }
  return (
    <section className="workflow__conflicts" ref={props.ref} tabIndex={-1} aria-label={props.summary} onClick={() => setArmed(null)}>
      <p className="workflow__conflicts-summary">{props.summary}</p>
      {typeof props.mergeBrief === 'string' && (
        <p className="workflow__conflicts-brief">
          merger brief: <code>{props.mergeBrief}</code>
          <button type="button" className="workflow__conflict-action" onClick={() => void props.ports.openBrief().then(setBriefRefusal)}>Open brief</button>
          {briefRefusal !== null && <span className="workflow__conflict-refusal" role="alert">{briefRefusal}</span>}
        </p>
      )}
      {ConflictGroups.of(props.conflicts.entries).map((group) => (
        <section key={group.id} className="workflow__conflict-group" data-group={group.id} aria-label={group.title}>
          <h4 className="workflow__conflict-group-title">{group.title}</h4>
          <ul className="workflow__conflict-rows">
            {group.entries.map((entry) => (
              <li key={ConflictOptions.rowOf(entry)} className="workflow__conflict" data-state={entry.state}>
                <span className="workflow__conflict-path">{named(entry) ? `${entry.path} (${entry.kind})` : entry.path}</span>
                <span className="workflow__conflict-description">{entry.description}</span>
                {entry.settled !== undefined ? <span className="workflow__conflict-note">{entry.settled}</span>
                  : entry.by !== null && <span className="workflow__conflict-note">{ConflictGroups.byOf(entry.by)}</span>}
                {entry.saved !== null && <span className="workflow__conflict-note">saved: <code>{entry.saved}</code></span>}
                {ConflictOptions.offered(entry) && (
                  <span className="workflow__conflict-options" role="group" aria-label={`Options for ${named(entry) ? `the ${entry.kind} conflict of ` : ''}${entry.path}`}>
                    {entry.options.map((option) => {
                      const key = ConflictOptions.keyOf(ConflictOptions.rowOf(entry), option.id)
                      return (
                        <button key={option.id} type="button" title={option.note} disabled={busy === ConflictOptions.rowOf(entry)}
                          className={`workflow__conflict-option${armed === key ? ' workflow__conflict-option--armed' : ''}`}
                          data-loses={option.loses} aria-pressed={armed === key}
                          onClick={(event) => {
                            event.stopPropagation()
                            press(entry, option)
                          }}
                          onBlur={() => setArmed((current) => current === key ? null : current)}>
                          {armed === key ? `${option.label}?` : option.label}
                        </button>
                      )
                    })}
                  </span>
                )}
                {entry.options.filter((option) => armed === ConflictOptions.keyOf(ConflictOptions.rowOf(entry), option.id)).map((option) => (
                  <span key={option.id} className="workflow__conflict-warning" role="alert">
                    {option.label}: {option.note}. Click it again to confirm.
                  </span>
                ))}
                <span className="workflow__conflict-actions">
                  <button type="button" className="workflow__conflict-action" onClick={() => run(entry, () => props.ports.openFile(entry.path))}>Open</button>
                  <button type="button" className="workflow__conflict-action" disabled={!!props.ports.editorUnavailable} title={props.ports.editorUnavailable}
                    onClick={() => run(entry, () => props.ports.openConflictEditor(entry.path))}>
                    Edit in TortoiseSVN
                  </button>
                </span>
                {noteOf(entry) !== null && <span className="workflow__conflict-refusal" role="alert">{noteOf(entry)}</span>}
              </li>
            ))}
          </ul>
        </section>
      ))}
      {more > 0 && (
        <p className="workflow__conflicts-more">
          {more} more not shown here; <code>jamat-v3 sessions conflicts</code> lists them all.
        </p>
      )}
    </section>
  )
}

export class ConflictOptions {
  /** A path still open offers its options; a fixed one has none left to choose. */
  static offered(entry: SessionSvnConflictInfo): boolean {
    return ConflictGroups.groupOf(entry.state) !== 'fixed' && entry.options.length > 0
  }

  static keyOf(row: string, option: SvnConflictOption): string {
    return `${row}\n${option}`
  }

  /** One row per conflict: a path with a text and a property conflict draws a row for each. */
  static rowOf(entry: Pick<SessionSvnConflictInfo, 'path' | 'kind'>): string {
    return `${entry.kind}\n${entry.path}`
  }
}

export class ConflictGroups {
  private static readonly orderConst: readonly ConflictGroupId[] = ['fixed', 'agent', 'person']

  /** The groups that hold an entry, in drawing order: fixed, the merger's, the person's. */
  static of(entries: readonly SessionSvnConflictInfo[]): ConflictGroup[] {
    return ConflictGroups.orderConst.flatMap((id) => {
      const members = entries.filter((entry) => ConflictGroups.groupOf(entry.state) === id)
      return members.length === 0 ? [] : [{ id, title: ConflictGroups.titleOf(id), entries: members }]
    })
  }

  static groupOf(state: SvnConflictState): ConflictGroupId {
    switch (state) {
      case 'rule': case 'settled': return 'fixed'
      case 'agent': return 'agent'
      case 'person': return 'person'
      default: throw new Error(`Unknown conflict state: ${JSON.stringify(state satisfies never)}`)
    }
  }

  /** Only for an older peer, which sends no `settled`; its `agent` was the worker or the merger. */
  static byOf(by: SvnConflictWireActor): string {
    switch (by) {
      case 'jamat': return 'fixed by Jamat'
      case 'agent': return 'fixed by an agent'
      case 'person': return 'fixed by you'
      default: throw new Error(`Unknown conflict actor: ${JSON.stringify(by satisfies never)}`)
    }
  }

  private static titleOf(id: ConflictGroupId): string {
    switch (id) {
      case 'fixed': return 'Fixed'
      case 'agent': return 'Merger works on'
      case 'person': return 'Needs you'
      default: throw new Error(`Unknown conflict group: ${JSON.stringify(id satisfies never)}`)
    }
  }
}
