import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'

import { ScriptDuration } from '../../../lib-orchestrator/sessionManager/scripts/scriptDuration'
import type {
  SessionInfo,
  SessionSetupAgreement,
  SessionsSnapshot,
  SessionWorkflowAction,
  SessionWorkflowInfo,
  SessionWorkflowStep,
  SessionWorkflowStepState,
  SessionWorkflowTarget,
} from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { SnapshotStore } from '../ipc/snapshotStore'
import type { FinalizeAgreement } from '../overlays/finalize/finalizeCatalog'
import { ConflictList, type ConflictListPorts } from './conflictList'
import './workflow.css'

/** How a footer press went: done, refused with its sentence, or asking what the Finish dialog asks. */
export type WorkflowPressAnswer =
  | { kind: 'done' }
  | { kind: 'refused'; sentence: string }
  | { kind: 'agreement'; setup: SessionSetupAgreement }
  | { kind: 'working'; sentence: string }

export interface WorkflowPorts {
  openStep(target: SessionWorkflowTarget, title: string): void
  press(action: SessionWorkflowAction, agreement: FinalizeAgreement): Promise<WorkflowPressAnswer>
  /** What the rows of the conflict list do. */
  conflicts: ConflictListPorts
}

/** What the footer shows under its presses after the last one. */
type WorkflowFooterNote =
  | { kind: 'none' }
  | { kind: 'refused'; sentence: string }
  | { kind: 'agreement'; action: SessionWorkflowAction; setup: SessionSetupAgreement }
  | { kind: 'working'; action: SessionWorkflowAction; sentence: string }

/**
 * The workflow of the tab's own session: every word, state and action is the library's
 * (`SessionInfo.workflow`). The pane adds the glyph, the durations from the timestamps, and the live
 * line of a running step: the session's own step for a client stage, the run's last output line for
 * a run. It ticks once a second only while it is visible and the workflow is open.
 */
export function WorkflowPane(props: {
  ref?: React.Ref<HTMLElement>
  session: SessionInfo | null
  /** Where the run sessions are read from, for the live line of a running run. */
  sessions: Pick<SnapshotStore<SessionsSnapshot>, 'current' | 'subscribe'>
  visible: boolean
  ports: WorkflowPorts
}): React.JSX.Element {
  const workflow = props.session?.workflow
  const now = useSecondTicks(props.visible && workflow?.open === true)
  const runLines = useRunLines(props.sessions, workflow)
  const [note, setNote] = useState<WorkflowFooterNote>({ kind: 'none' })
  const [busy, setBusy] = useState(false)
  const conflictsRef = useRef<HTMLElement>(null)
  const ports = props.ports
  const action = props.session?.svnAction
  const conflicts = action?.conflicts ?? null
  const summary = action?.summary ?? null
  // The list belongs to the newest conflict step; an older round's step only says it waited.
  const conflictStep = (workflow?.rounds ?? []).flatMap((round) => round.steps).filter((step) => step.target.kind === 'conflicts').at(-1)?.key
  const showsConflicts = (step: SessionWorkflowStep): boolean => step.key === conflictStep && conflicts !== null && summary !== null
  const press = async (action: SessionWorkflowAction, agreement: FinalizeAgreement): Promise<void> => {
    setBusy(true)
    setNote({ kind: 'none' })
    try {
      setNote(WorkflowFooterNotes.of(action, await ports.press(action, agreement)))
    } finally {
      setBusy(false)
    }
  }
  if (workflow === undefined)
    return (
      <section className="workflow" ref={props.ref} tabIndex={-1} aria-label="Workflow">
        <p className="workflow__empty">Nothing runs for this session now.</p>
      </section>
    )
  return (
    <section className="workflow" ref={props.ref} tabIndex={-1} aria-label="Workflow" data-open={workflow.open}>
      <header className="workflow__header">
        <h2 className="workflow__title">{workflow.title}</h2>
        <p className="workflow__summary">{workflow.summary}</p>
      </header>
      <div className="workflow__rounds">
        {workflow.rounds.map((round, index) => (
          <section key={`${index}:${round.title}`} className="workflow__round" aria-label={round.title}>
            {workflow.rounds.length > 1 && <h3 className="workflow__round-title">{round.title}</h3>}
            <ol className="workflow__steps">
              {round.steps.map((step) => (
                <li key={step.key}>
                  <WorkflowStepRow
                    step={step}
                    now={now}
                    live={WorkflowLive.textOf(step, props.session?.step?.text ?? null, runLines)}
                    opens={step.target.kind === 'conflicts' ? showsConflicts(step) : step.target.kind !== 'none'}
                    onOpen={() => step.target.kind === 'conflicts'
                      ? WorkflowConflicts.reveal(conflictsRef.current)
                      : props.ports.openStep(step.target, step.title)}
                  />
                  {showsConflicts(step) && conflicts !== null && summary !== null
                    && <ConflictList ref={conflictsRef} summary={summary} conflicts={conflicts}
                      mergeBrief={action?.mergeBrief ?? null} ports={ports.conflicts} />}
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>
      {(workflow.actions.length > 0 || note.kind !== 'none') && (
        <footer className="workflow__footer">
          {workflow.actions.map((action) => (
            <button
              key={action.id}
              type="button"
              className={`workflow__action${action.primary ? ' workflow__action--primary' : ''}`}
              disabled={busy}
              onClick={() => void press(action, {})}
            >
              {action.label}
            </button>
          ))}
          <WorkflowFooterNoteView note={note} busy={busy} onAgree={(action, agreement) => void press(action, agreement)} />
        </footer>
      )}
    </section>
  )
}

function WorkflowStepRow(props: { step: SessionWorkflowStep; now: number; live: string | null; opens: boolean; onOpen(): void }): React.JSX.Element {
  const { step } = props
  const body = (
    <>
      <span className="workflow__glyph" aria-label={WorkflowStepGlyphs.labelOf(step.state)}>{WorkflowStepGlyphs.of(step.state)}</span>
      <span className="workflow__step-title">{step.title}</span>
      <span className="workflow__time">{WorkflowDurations.textOf(step, props.now)}</span>
      {(props.live ?? step.detail) !== '' && <span className="workflow__detail">{props.live ?? step.detail}</span>}
    </>
  )
  if (!props.opens)
    return <div className="workflow__step" data-state={step.state}>{body}</div>
  return (
    <button type="button" className="workflow__step workflow__step--opens" data-state={step.state} onClick={props.onOpen}>
      {body}
    </button>
  )
}

/** The refusal, or the agreement and still-working questions the Finish dialog asks, under the presses. */
function WorkflowFooterNoteView(props: {
  note: WorkflowFooterNote
  busy: boolean
  onAgree(action: SessionWorkflowAction, agreement: FinalizeAgreement): void
}): React.JSX.Element | null {
  const note = props.note
  const kind = note.kind
  switch (kind) {
    case 'none': return null
    case 'refused': return <p className="workflow__refusal" role="alert">{note.sentence}</p>
    case 'agreement':
      return (
        <div className="workflow__agreement" role="group" aria-label="Command agreement">
          <p>This project asks to run these commands in its worktrees before the Finish goes on:</p>
          <ul>{note.setup.commands.map((command, index) => <li key={index}><code>{command}</code></li>)}</ul>
          <button type="button" className="workflow__action workflow__action--primary" disabled={props.busy}
            onClick={() => props.onAgree(note.action, { acknowledgeSetup: note.setup.hash })}>Agree and finish</button>
        </div>
      )
    case 'working':
      return (
        <div className="workflow__agreement" role="group" aria-label="Session still works">
          <p role="alert">{note.sentence}</p>
          <button type="button" className="workflow__action workflow__action--primary" disabled={props.busy}
            onClick={() => props.onAgree(note.action, { confirmWorking: true })}>Finish anyway</button>
        </div>
      )
    default: throw new Error(`Unknown workflow footer note: ${JSON.stringify(kind satisfies never)}`)
  }
}

class WorkflowFooterNotes {
  static of(action: SessionWorkflowAction, answer: WorkflowPressAnswer): WorkflowFooterNote {
    const kind = answer.kind
    switch (kind) {
      case 'done': return { kind: 'none' }
      case 'refused': return { kind: 'refused', sentence: answer.sentence }
      case 'agreement': return { kind: 'agreement', action, setup: answer.setup }
      case 'working': return { kind: 'working', action, sentence: answer.sentence }
      default: throw new Error(`Unknown workflow press answer: ${JSON.stringify(kind satisfies never)}`)
    }
  }
}

/** One tick a second while `enabled`, as the Processes tab does; none while hidden or settled. */
function useSecondTicks(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [enabled])
  return now
}

/**
 * The last output line of each running run step, read from the snapshot. A string is the store's
 * value, so the pane draws again only when a line moved, never for another session's change.
 */
function useRunLines(
  sessions: Pick<SnapshotStore<SessionsSnapshot>, 'current' | 'subscribe'>,
  workflow: SessionWorkflowInfo | undefined,
): ReadonlyMap<string, string> {
  const runIds = WorkflowLive.runningRunsOf(workflow).join('\n')
  const read = useCallback((): string => {
    if (runIds === '') return ''
    const wanted = new Set(runIds.split('\n'))
    const lines = (sessions.current().snapshot?.sessions ?? [])
      .filter((session) => wanted.has(session.sessionId) && session.step !== undefined)
      .map((session) => [session.sessionId, session.step?.text ?? ''])
    return JSON.stringify(lines)
  }, [sessions, runIds])
  const subscribe = useCallback((listener: () => void) => sessions.subscribe(listener), [sessions])
  const value = useSyncExternalStore(subscribe, read)
  return new Map(value === '' ? [] : JSON.parse(value) as [string, string][])
}

export class WorkflowConflicts {
  /** A click on the conflict step brings its list into view. */
  static reveal(list: HTMLElement | null): void {
    if (list === null) return
    list.scrollIntoView?.({ block: 'nearest' })
    list.focus({ preventScroll: true })
  }
}

export class WorkflowLive {
  /** The run ids of the running steps that have a run. */
  static runningRunsOf(workflow: SessionWorkflowInfo | undefined): string[] {
    return (workflow?.rounds ?? []).flatMap((round) => round.steps)
      .flatMap((step) => step.state === 'running' && 'runId' in step.target ? [step.target.runId] : [])
  }

  /** A running client stage says the session's step; a running run its last output line; anything else its detail. */
  static textOf(step: SessionWorkflowStep, sessionStep: string | null, runLines: ReadonlyMap<string, string>): string | null {
    if (step.state !== 'running') return null
    const target = step.target
    const kind = target.kind
    switch (kind) {
      case 'none': return sessionStep
      case 'run': case 'agent': case 'commit': return runLines.get(target.runId) ?? null
      case 'conflicts': return null
      default: throw new Error(`Unknown workflow target: ${JSON.stringify(kind satisfies never)}`)
    }
  }
}

export class WorkflowDurations {
  static textOf(step: SessionWorkflowStep, now: number): string {
    if (step.startedAt === null) return ''
    if (step.state === 'running') return ScriptDuration.elapsedText(now - step.startedAt)
    return step.endedAt === null ? '' : ScriptDuration.text(step.endedAt - step.startedAt)
  }
}

export class WorkflowStepGlyphs {
  static of(state: SessionWorkflowStepState): string {
    switch (state) {
      case 'pending': return '○'
      case 'running': return '◐'
      case 'done': return '✓'
      case 'failed': return '✕'
      case 'waits': return '!'
      case 'skipped': return '-'
      default: throw new Error(`Unknown workflow step state: ${JSON.stringify(state satisfies never)}`)
    }
  }

  static labelOf(state: SessionWorkflowStepState): string {
    switch (state) {
      case 'pending': return 'Pending'
      case 'running': return 'Running'
      case 'done': return 'Done'
      case 'failed': return 'Failed'
      case 'waits': return 'Waits for you'
      case 'skipped': return 'Skipped'
      default: throw new Error(`Unknown workflow step state: ${JSON.stringify(state satisfies never)}`)
    }
  }
}
