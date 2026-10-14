import { useState } from 'react'

import type {
  SessionSvnConflictInfo,
  SessionSvnConflictOptionInfo,
  SvnConflictActor,
  SvnConflictState,
} from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { SvnConflictOption } from '../../../lib-orchestrator/svn/svn.types'

/** What a row does; each answers the refusal the row shows, or null. */
export interface ConflictListPorts {
  /** One option on the path; `confirm` only after the person confirmed a loss of incoming work. */
  resolve(path: string, option: SvnConflictOption, confirm: boolean): Promise<string | null>
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
 * admits, with the library's labels and notes; an option that loses incoming work shows its note as a
 * warning on the first click and runs, confirmed, only on the second, and any other click disarms it.
 * Each row also opens its path in the viewer or in TortoiseSVN's conflict editor, and shows the
 * refusal of the last thing it ran. A settled row moves to Fixed with the next snapshot.
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
  const [notes, setNotes] = useState<ReadonlyMap<string, string>>(new Map())
  const [armed, setArmed] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [briefRefusal, setBriefRefusal] = useState<string | null>(null)
  const run = (path: string, work: () => Promise<string | null>): void => {
    void work().then((refusal) => setNotes((current) => {
      const next = new Map(current)
      if (refusal === null) next.delete(path)
      else next.set(path, refusal)
      return next
    }))
  }
  const press = (entry: SessionSvnConflictInfo, option: SessionSvnConflictOptionInfo): void => {
    const key = ConflictOptions.keyOf(entry.path, option.id)
    const confirms = option.loses === 'incoming'
    if (confirms && armed !== key) {
      setArmed(key)
      return
    }
    setArmed(null)
    setBusy(entry.path)
    run(entry.path, () => props.ports.resolve(entry.path, option.id, confirms).finally(() => setBusy(null)))
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
              <li key={entry.path} className="workflow__conflict" data-state={entry.state}>
                <span className="workflow__conflict-path">{entry.path}</span>
                <span className="workflow__conflict-description">{entry.description}</span>
                {entry.by !== null && <span className="workflow__conflict-note">{ConflictGroups.byOf(entry.by)}</span>}
                {entry.saved !== null && <span className="workflow__conflict-note">saved: <code>{entry.saved}</code></span>}
                {ConflictOptions.offered(entry) && (
                  <span className="workflow__conflict-options" role="group" aria-label={`Options for ${entry.path}`}>
                    {entry.options.map((option) => {
                      const key = ConflictOptions.keyOf(entry.path, option.id)
                      return (
                        <button key={option.id} type="button" title={option.note} disabled={busy === entry.path}
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
                {entry.options.filter((option) => armed === ConflictOptions.keyOf(entry.path, option.id)).map((option) => (
                  <span key={option.id} className="workflow__conflict-warning" role="alert">
                    {option.label}: {option.note}. Click it again to confirm.
                  </span>
                ))}
                <span className="workflow__conflict-actions">
                  <button type="button" className="workflow__conflict-action" onClick={() => run(entry.path, () => props.ports.openFile(entry.path))}>Open</button>
                  <button type="button" className="workflow__conflict-action" onClick={() => run(entry.path, () => props.ports.openConflictEditor(entry.path))}>
                    Edit in TortoiseSVN
                  </button>
                </span>
                {notes.has(entry.path) && <span className="workflow__conflict-refusal" role="alert">{notes.get(entry.path)}</span>}
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

  static keyOf(path: string, option: SvnConflictOption): string {
    return `${path}\n${option}`
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

  static byOf(by: SvnConflictActor): string {
    switch (by) {
      case 'jamat': return 'fixed by Jamat'
      case 'agent': return 'fixed by the merger'
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
