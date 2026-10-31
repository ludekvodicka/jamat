import { useCallback, useEffect, useRef, useState } from 'react'

import type { SessionInfo, SessionsSnapshot, SessionWorkflowAction, SessionWorkflowInfo, SessionWorkflowStep } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { SnapshotStore } from '../ipc/snapshotStore'
import { ErrorText } from '../../shared/errorText'
import type { FinalizeAgreement } from '../overlays/finalize/finalizeCatalog'
import { WorkflowPane, WorkflowStepRow, WorkflowPlaces, WorkflowLive, WorkflowFooterNotes, WorkflowFooterNoteView,
  useRunLines, useSecondTicks, type WorkflowPorts } from '../workflow/workflowPane'
import { CommitPane, type CommitPaneDraftState } from '../versioning/commitPane'
import { CommitPaneChannel } from '../versioning/commitPanePorts'
import { CommitTargets } from '../../shared/commitTargets'
import type { FileViewerChangedOpen } from '../fileViewer/fileViewerPanel.types'
import { StepBody } from './stepBody'
import { WorktreeValidation } from './worktreeValidation'
import './sessionActions.css'

const repositoryKey = (repository: { root: string; repository: string }): string => JSON.stringify([repository.root, repository.repository])
/** Where a repository's working copy sits under the review scope, as the file list names its group: empty for the scope itself. */
const mountOf = (scopeRoot: string, root: string): string => {
  const scope = scopeRoot.replace(/\\/g, '/').replace(/\/+$/, '')
  const path = root.replace(/\\/g, '/').replace(/\/+$/, '')
  if (path.toLowerCase() === scope.toLowerCase()) return ''
  return path.toLowerCase().startsWith(`${scope.toLowerCase()}/`) ? path.slice(scope.length + 1) : root
}

interface ActionsPaneProps {
  ref?: React.Ref<HTMLElement>
  session: SessionInfo | null
  sessions: Pick<SnapshotStore<SessionsSnapshot>, 'current' | 'subscribe'>
  visible: boolean
  unavailable?: string | null
  ports: WorkflowPorts
  onOpenChanged?(value: FileViewerChangedOpen): string | null
  onOpenSeparately?(vcs: 'svn' | 'git', scopeRoot: string): void
}

export function SessionActionsPane(props: ActionsPaneProps): React.JSX.Element {
  const [dismissedReview, setDismissedReview] = useState<string | null>(null)
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({})
  const [expandedSteps, setExpandedSteps] = useState<Record<string, Record<string, boolean>>>({})
  const [clearing, setClearing] = useState(false)
  const [clearError, setClearError] = useState<string | null>(null)
  const [container, setContainer] = useState<HTMLElement | null>(null)
  const outerRef = props.ref
  const ref = useCallback((node: HTMLElement | null) => {
    setContainer(node)
    if (typeof outerRef === 'function') outerRef(node)
    else if (outerRef) outerRef.current = node
  }, [outerRef])
  SessionActionsScroll.useFollowEnd(container)
  if (props.unavailable) return <section ref={props.ref} tabIndex={-1} aria-label="Session actions"><p role="status">{props.unavailable}</p></section>
  if (props.session?.actions === undefined) return <WorkflowPane {...props} />
  const sections = props.session.actions.sections.map((section) => {
    const current = WorkflowPlaces.currentStepOf(section)
    const review = section.open && props.ports.reviews !== undefined ? section.rounds.flatMap((round) => round.steps)
      .find((step) => step.key === current && step.body?.kind === 'commit') : undefined
    return { section, review, reviewKey: review === undefined ? null : `${section.workflowId}:${review.key}` }
  })
  const pending = sections.findLast((entry) => entry.review !== undefined)
  const activeReview = pending?.reviewKey !== dismissedReview ? pending?.reviewKey ?? null : null
  return <section ref={ref} tabIndex={-1} aria-label="Session actions" className={`session-actions${activeReview === null ? '' : ' session-actions--review'}`}
    onKeyDown={(event) => {
      if (activeReview === null || event.key !== 'Escape' || event.nativeEvent.isComposing || event.repeat || event.altKey || event.ctrlKey || event.metaKey
        || (event.target instanceof Element && event.target.closest('[role="menu"]'))) return
      event.preventDefault()
      event.stopPropagation()
      setDismissedReview(activeReview)
    }}>
    <div className="session-actions__toolbar" role="toolbar" aria-label="Session actions tools" hidden={activeReview !== null}>
      <button type="button" className="workflow__action" title="Clear completed actions and their saved logs"
        disabled={!props.ports.clearHistory || clearing || !sections.some(({ section }) => !section.open && section.actions.length === 0)} onClick={() => {
          setClearing(true)
          setClearError(null)
          void Promise.resolve().then(() => props.ports.clearHistory!())
            .then(setClearError)
            .catch((error: unknown) => setClearError(ErrorText.of(error)))
            .finally(() => setClearing(false))
        }}>{clearing ? 'Clearing…' : 'Clear'}</button>
      <button type="button" className="workflow__action" disabled={sections.length === 0} onClick={() => {
        setExpandedSections(Object.fromEntries(sections.map(({ section }) => [section.workflowId, false])))
        setExpandedSteps(Object.fromEntries(sections.map(({ section }) => [section.workflowId,
          Object.fromEntries(section.rounds.flatMap((round) => round.steps).map((step) => [step.key, false]))])))
      }}>Collapse all</button>
      {clearError !== null && <p role="alert" className="workflow__refusal">{clearError}</p>}
    </div>
    {props.session.actions.sections.length === 0 && <p className="workflow__empty">No session actions recorded.</p>}
    {sections.map(({ section, review, reviewKey }) => <ActionsSection key={section.workflowId} {...props} section={section} review={review}
      expanded={expandedSections[section.workflowId]} expandedSteps={expandedSteps[section.workflowId] ?? {}}
      onExpand={(value) => setExpandedSections((held) => ({ ...held, [section.workflowId]: value }))}
      onExpandStep={(key, value) => setExpandedSteps((held) => ({ ...held, [section.workflowId]: { ...held[section.workflowId], [key]: value } }))}
      reviewOpen={reviewKey !== null && reviewKey === activeReview} hidden={activeReview !== null && reviewKey !== activeReview}
      onReview={() => setDismissedReview(null)} onCloseReview={() => setDismissedReview(reviewKey)} />)}
  </section>
}

function ActionsSection(props: ActionsPaneProps & { section: SessionWorkflowInfo; review?: SessionWorkflowStep; reviewOpen: boolean; hidden: boolean
  expanded?: boolean; expandedSteps: Record<string, boolean>; onExpand(value: boolean): void; onExpandStep(key: string, value: boolean): void
  onReview(): void; onCloseReview(): void }): React.JSX.Element {
  const section = props.section
  // A closed section that still offers presses, such as a kept worktree's Discard, starts open too.
  const initiallyExpanded = useRef(section.open || section.actions.length > 0)
  const expanded = props.expanded ?? initiallyExpanded.current
  const [note, setNote] = useState<ReturnType<typeof WorkflowFooterNotes.of>>({ kind: 'none' })
  const [busy, setBusy] = useState(false)
  /** The press that waits for its answer; a Finish step can take seconds before the record moves (UA1-J09-8). */
  const [pressing, setPressing] = useState<SessionWorkflowAction | null>(null)
  /** The step that waited when Publish was pressed; the press answers only after the whole drive, removal included. */
  const [pressedStep, setPressedStep] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<SessionWorkflowAction | null>(null)
  /** The step whose presses Later folded into its line; the step itself still waits. */
  const [deferred, setDeferred] = useState<{ key: string; line: string } | null>(null)
  const repositoryReviews: NonNullable<CommitPaneDraftState['repositories']> = props.review?.body?.kind === 'commit' ? props.review.body.repositories ?? [] : []
  // A peer of an older build sends no separateMessages, only its several repositories.
  const multipleRepositories = repositoryReviews.length > 1 || props.review?.body?.kind === 'commit' && props.review.body.separateMessages === true && repositoryReviews.length > 0
  const [repositoryMessages, setRepositoryMessages] = useState<Record<string, string>>({})
  const [repositoryAcknowledgements, setRepositoryAcknowledgements] = useState<Record<string, string>>({})
  const [repositoryDrafts, setRepositoryDrafts] = useState<CommitPaneDraftState['repositories']>()
  const repositories = (repositoryDrafts ?? repositoryReviews).map((repository) => ({ ...repository,
    acknowledged: repositoryAcknowledgements[repositoryKey(repository)] === repository.message
      ? ('findings' in repository ? repository.findings?.map((finding) => finding.id) ?? [] : []) : [],
  }))
  const unsavedRepositories = repositories.some((repository) => repositoryMessages[repositoryKey(repository)] !== undefined
    && repositoryMessages[repositoryKey(repository)] !== repository.message)
  const draft = useRef<CommitPaneDraftState | null>(null)
  const reviewVersion = useRef<{ key: string; version: number | undefined } | null>(null)
  const [reviewReload, setReviewReload] = useState(0)
  if (!props.reviewOpen) reviewVersion.current = null
  if (props.reviewOpen && props.review !== undefined && reviewVersion.current?.key !== props.review.key)
    reviewVersion.current = { key: props.review.key, version: props.session?.worktreeView?.version }
  const outdated = reviewVersion.current !== null && reviewVersion.current.version !== props.session?.worktreeView?.version
  const [acknowledgedMessage, setAcknowledgedMessage] = useState<string | null>(null)
  const messageKey = (state: CommitPaneDraftState): string => JSON.stringify([state.message, state.messageSource, state.messageFindings])
  // Nothing is missing from a selection that has not loaded yet; it named every file while the dialog opened (UA1-J13-7).
  const missingSelection = (state: CommitPaneDraftState): string[] => !state.ready ? [] : section.validation?.requiredSelection?.filter((path) =>
    !state.checked.some((selected) => selected.replace(/\\/g, '/') === path.replace(/\\/g, '/'))) ?? []
  /** Why Publish waits on a repository message, naming the repository as its field does (UA1-J12-7). */
  const reviewScope = props.review?.body?.kind === 'commit' ? props.review.body.scopeRoot : null
  const repositoryWaits = (state: CommitPaneDraftState): string[] => !multipleRepositories || reviewScope === null ? [] : repositories
    .filter((repository) => state.checked.some((path) => path.replace(/\\/g, '/').startsWith(repository.root.replace(/\\/g, '/') + '/')))
    .flatMap((repository) => {
      const findings = 'findings' in repository ? repository.findings ?? [] : []
      const label = `${repository.repositoryName} (${mountOf(reviewScope, repository.root) || '.'})`
      if (findings.some((finding) => finding.id === 'empty')) return [`Enter a commit message for ${label}.`]
      return findings.some((finding) => finding.confirm === true && !repository.acknowledged.includes(finding.id))
        ? [`Check the message for ${label} and tick "I checked this repository message".`] : []
    })
  const reviewPane = useRef<HTMLElement>(null)
  const historyPane = useRef<HTMLDivElement>(null)
  const visible = props.visible && expanded && !props.hidden && !props.reviewOpen
  useEffect(() => {
    if (props.visible && !props.hidden)
      (props.reviewOpen ? reviewPane.current : historyPane.current)?.focus()
  }, [props.reviewOpen, props.visible, props.hidden])
  const now = useSecondTicks(visible && section.open)
  const lines = useRunLines(props.sessions, section)
  const current = WorkflowPlaces.currentStepOf(section)
  // Two clicks in one task both reach an enabled button before `busy` draws (UA1-J12-6): the second
  // is dropped here, and the first sends the version it saw, not one a later render cleared.
  // A button sends the review it was drawn with: `draft` follows one effect later, and a click in
  // between read a review whose file list had not loaded. An agreement answered later has only `draft`.
  const inFlight = useRef(false)
  const press = async (action: SessionWorkflowAction, agreement: FinalizeAgreement, drawn?: CommitPaneDraftState): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    const pressedVersion = reviewVersion.current?.version
    setBusy(true)
    setPressing(action)
    setPressedStep(current)
    setNote({ kind: 'none' })
    try {
      if (action.requiresCommit && outdated) {
        setNote({ kind: 'refused', sentence: 'This review is outdated' })
        return
      }
      const state = action.requiresCommit ? drawn ?? draft.current : null
      const reviewed = state?.review ? await state.review() : null
      if (reviewed !== null && 'lost' in reviewed) {
        setNote({ kind: 'refused', sentence: CommitPaneChannel.notSentOf(reviewed.lost) })
        return
      }
      const proof = reviewed
      const revision = props.sessions.current().snapshot?.revision
      if (state?.review && (!proof || revision === undefined)) {
        setNote({ kind: 'refused', sentence: 'The shared review changed. Read the source selection and message again.' })
        return
      }
      if (action.requiresCommit) props.onCloseReview()
      const answer = await props.ports.press(action, agreement, state === null ? undefined : {
        ...(multipleRepositories ? { repositories } : {}),
        selection: [...state.checked], message: proof?.message ?? state.message, messageSource: state.messageSource ?? 'unknown',
        ...pressedVersion === undefined ? {} : { reviewVersion: pressedVersion },
        acknowledgedFindings: acknowledgedMessage === messageKey(state) ? state.messageFindings?.map((finding) => finding.id) ?? [] : [],
        ...(proof ? { reviewed: { proof, workflowId: section.workflowId, revision: revision! } } : {}),
      })
      if (action.id === 'later' && action.deferred !== undefined && answer.kind === 'done' && current !== null) setDeferred({ key: current, line: action.deferred })
      setNote(WorkflowFooterNotes.of(action, answer))
    }
    catch (error) { setNote({ kind: 'refused', sentence: String(error) }) }
    finally { inFlight.current = false; setBusy(false); setPressing(null) }
  }
  const buttons = (actions: SessionWorkflowAction[], state?: CommitPaneDraftState): React.JSX.Element => <>
    {actions.map((action) => <button key={action.id} type="button"
      className={`workflow__action${action.primary ? ' workflow__action--primary' : ''}${action.confirm ? ' session-actions__danger' : ''}`}
      disabled={busy || action.requiresCommit === true && (outdated || state?.ready !== true || missingSelection(state).length > 0 || unsavedRepositories || repositoryWaits(state).length > 0 || !multipleRepositories && state.checked.length > 0 && (state.messageFindings?.some((finding) => finding.id === 'empty') === true
        || state.messageFindings?.some((finding) => finding.confirm === true) === true && acknowledgedMessage !== messageKey(state)) || !multipleRepositories && (state.checked.length > 0 ? !state.message.trim() : state.hasChanges))}
      onClick={() => action.confirm === undefined ? void press(action, {}, state) : setConfirm(action)}>{action.label}</button>)}
    {actions.some((action) => !action.primary && action.note !== undefined) && <ul className="workflow__action-notes">
      {actions.filter((action) => !action.primary && action.note !== undefined).map((action) => <li key={action.id}>{action.label}: {action.note}</li>)}
    </ul>}
    {confirm !== null && actions.some((action) => action.id === confirm.id) && <div className="session-actions__confirm" role="alert">
      <p>{confirm.confirm}</p>
      <button type="button" className="workflow__action session-actions__danger" disabled={busy}
        onClick={() => { setConfirm(null); void press(confirm, {}, state) }}>Confirm {confirm.label}</button>
      <button type="button" className="workflow__action" onClick={() => setConfirm(null)}>Cancel</button>
    </div>}
    {pressing !== null && actions.some((action) => action.id === pressing.id)
      && <p role="status" className="workflow__summary">{pressing.label}: sent, Jamat works on it</p>}
  </>
  const reviewBody = props.review?.body
  return <section className={`session-actions__section${props.reviewOpen ? ' session-actions__section--review' : ''}`} aria-label={section.title} hidden={props.hidden}>
    <div ref={historyPane} tabIndex={-1} hidden={props.reviewOpen}>
    <button className="session-actions__heading" type="button" aria-expanded={expanded} onClick={() => props.onExpand(!expanded)}>{section.title}
      {section.startedAt !== undefined && <time className="session-actions__time" dateTime={new Date(section.startedAt).toISOString()}>
        {new Date(section.startedAt).toLocaleString()}</time>}</button>
    {expanded && <>
      <p className="workflow__summary">{section.summary}</p>
      {section.validation && <WorktreeValidation value={section.validation} ports={props.ports} />}
      {section.rounds.map((round, index) => <section key={index} aria-label={round.title}>
        {section.rounds.length > 1 && <h3 className="workflow__round-title">{round.title}</h3>}
        <ol className="workflow__steps">{round.steps.map((step) => {
          // Publish closes the review, and the record leaves the person's wait only after Finish has
          // checked the approved files again, seconds later; until then the step drew its old request.
          const publishing = step.key === current && step.key === pressedStep && pressing?.requiresCommit === true
          return <li key={step.key}>
          <ActionsStep step={publishing ? { ...step, state: 'running' } : step} sessionId={props.session!.sessionId} now={now} visible={visible} ports={props.ports}
            expanded={props.expandedSteps[step.key]} onExpand={(value) => props.onExpandStep(step.key, value)}
            onReview={step === props.review ? () => { reviewVersion.current = { key: step.key, version: props.session?.worktreeView?.version }; props.onReview() } : undefined} busy={busy}
            live={publishing ? `${pressing.label}: sent, Jamat works on it` : WorkflowLive.textOf(step, WorkflowLive.stepTextOf(props.session?.step), lines)}
            progress={WorkflowLive.fractionOf(step, props.session?.step)} />
          {step.key === current && !publishing && <div className="workflow__step-actions" role="group" aria-label={`${step.title} actions`}>
            {deferred?.key === step.key ? <>
              <p role="status" className="workflow__summary">{deferred.line}</p>
              <button type="button" className="session-actions__toggle" onClick={() => setDeferred(null)}>
                Show {section.actions.filter((action) => action.place === 'step' && !action.requiresCommit && action.id !== 'later').map((action) => action.label).join(', ')}
              </button>
            </> : buttons(section.actions.filter((action) => action.place === 'step' && !action.requiresCommit))}</div>}
        </li>
        })}</ol>
      </section>)}
      <footer className="workflow__footer">{buttons(section.actions.filter((action) => action.place !== 'step' || current === null))}
        <WorkflowFooterNoteView note={note} busy={busy} onAgree={(action, agreement) => void press(action, agreement)} />
      </footer>
    </>}
    </div>
    {reviewBody?.kind === 'commit' && props.ports.reviews !== undefined && <section ref={reviewPane} tabIndex={-1} className="session-actions__review" aria-label="Review changes" hidden={!props.reviewOpen}>
      <header className="session-actions__review-header">
        <div><h2 className="workflow__title">Review changes</h2><p className="workflow__summary">{section.title}</p>
          <p className="workflow__summary" role="status">{section.badge}</p></div>
        <button type="button" className="workflow__action" disabled={busy} onClick={props.onCloseReview}>Back to Session actions</button>
      </header>
      {section.validation && <WorktreeValidation value={section.validation} ports={props.ports} />}
      {section.validation && <div className="workflow__actions">{buttons(section.actions.filter((action) => action.place === 'step' && !action.requiresCommit))}</div>}
      {reviewBody.marked !== undefined && reviewBody.marked.length > 0 && <p className="workflow__refusal" role="status">
        Changed during update. Review again: {reviewBody.marked.join(', ')}
      </p>}
      {outdated && <div><p role="status">This review is outdated. Reload the files before approving.</p>
        <button type="button" className="workflow__action" disabled={busy} onClick={() => {
          draft.current = null
          reviewVersion.current = { key: props.review!.key, version: props.session?.worktreeView?.version }
          setAcknowledgedMessage(null)
          setRepositoryAcknowledgements({})
          setRepositoryDrafts(undefined)
          setReviewReload((value) => value + 1)
        }}>Reload current review</button></div>}
      {note.kind === 'refused' && <p role="alert">{note.sentence}</p>}
      <CommitPane ports={props.ports.reviews} key={`${props.review!.key}:${reviewReload}`} reviewOnly sessionId={props.session!.sessionId}
        messageEditor={multipleRepositories ? <div className="session-actions__repositories">{repositories
          .map((repository) => ({ repository, displayPath: mountOf(reviewBody.scopeRoot, repository.root) }))
          // The file list shows the scope's own files first, then each external group by path; publication order stays as received.
          .sort(CommitTargets.byPath).map(({ repository, displayPath }) => {
          const mount = displayPath || '.'
          const findings = 'findings' in repository ? repository.findings ?? [] : []
          return <div key={repository.root} className="session-actions__repository">
            <label className="session-actions__repository-message">
              <span><strong>{repository.repositoryName}</strong> <span className="session-actions__repository-root" title={repository.root}>
                {displayPath === '' ? 'Project files (.)' : `External: ${displayPath}`}</span>
                <span className="session-actions__repository-source">Source: {repository.source}</span></span>
              <textarea aria-label={`Commit message ${repository.repositoryName} (${mount})`} disabled={busy}
                value={repositoryMessages[repositoryKey(repository)] ?? (repository.message || `${repository.expectedPrefix} `)} placeholder={`${repository.expectedPrefix} Describe the change`}
                onChange={(event) => {
                  const message = event.target.value
                  setRepositoryMessages((messages) => ({ ...messages, [repositoryKey(repository)]: message }))
                  void draft.current?.saveRepositoryMessage?.(repository.root, message)
                    .catch((error: unknown) => setNote({ kind: 'refused', sentence: ErrorText.of(error) }))
                }} />
            </label>
            {findings.map((finding) => <p key={finding.id} className="commit-warning" role="status">{finding.text}</p>)}
            {findings.some((finding) => finding.confirm === true) && !findings.some((finding) => finding.id === 'empty') && <label>
              <input type="checkbox" checked={repositoryAcknowledgements[repositoryKey(repository)] === repository.message}
                onChange={(event) => setRepositoryAcknowledgements((messages) => ({ ...messages, [repositoryKey(repository)]: event.target.checked ? repository.message : '' }))} />
              I checked this repository message</label>}
          </div>
        })}</div> : undefined}
        item={{ kind: 'commit', key: `actions:${reviewBody.scopeRoot}`, title: props.review!.title, vcs: reviewBody.vcs, scopeRoot: reviewBody.scopeRoot }}
        onDraftState={(state) => {
          draft.current = state
          setRepositoryDrafts(state.repositories)
          setRepositoryMessages((messages) => {
            const pending = Object.entries(messages).filter(([key, message]) => state.repositories?.some((repository) => repositoryKey(repository) === key && repository.message !== message))
            return pending.length === Object.keys(messages).length ? messages : Object.fromEntries(pending)
          })
        }} unsentText={unsavedRepositories} onReloadEdits={() => setNote({ kind: 'none' })} onClose={props.onCloseReview}
          footer={(state) => <div className="commit-actions">{missingSelection(state).length > 0 && <div role="status" className="session-actions__missing">
            <p>Include the whole verified change set. Missing:</p>
            <ul aria-label="Missing from the selection">{missingSelection(state).map((path) => <li key={path} title={path}>{mountOf(reviewBody.scopeRoot, path) || '.'}</li>)}</ul>
          </div>}{repositoryWaits(state).map((wait) => <p key={wait} role="status" className="session-actions__missing">{wait}</p>)}
          {/* With several repositories the top-level message is hidden and nothing publishes it, so nobody checks it. */}
          {!multipleRepositories && state.checked.length > 0 && state.messageFindings?.some((finding) => finding.confirm === true) === true && !state.messageFindings.some((finding) => finding.id === 'empty') && <label>
          <input type="checkbox" checked={acknowledgedMessage === messageKey(state)} onChange={(event) => setAcknowledgedMessage(event.target.checked ? messageKey(state) : null)} />
          I checked this message
        </label>}{buttons(section.actions.filter((action) => action.requiresCommit), state)}</div>}
        onOpenChanged={props.onOpenChanged ?? (() => 'The file viewer is unavailable')}
        onOpenSeparately={(root) => props.onOpenSeparately?.(reviewBody.vcs, root)} />
    </section>}
  </section>
}

function ActionsStep(props: { step: SessionWorkflowStep; sessionId: string; now: number; visible: boolean; live: string | null; progress: number | null; ports: WorkflowPorts
  onReview?(): void; busy: boolean; expanded?: boolean; onExpand(value: boolean): void }): React.JSX.Element {
  const { step } = props
  const detailsToggle = useRef<HTMLButtonElement>(null)
  const initiallyExpanded = useRef(step.state === 'waits')
  const expanded = props.expanded ?? initiallyExpanded.current
  return <>
    <WorkflowStepRow step={step} now={props.now} live={props.live} progress={props.progress}
      opens={step.body?.kind === 'commit' ? props.onReview !== undefined && !props.busy : step.body !== undefined || step.target.kind === 'agent'}
      onOpen={() => {
        if (step.body?.kind === 'commit') { if (!props.busy) props.onReview?.() }
        else if (step.body === undefined) props.ports.openStep(step.target, step.title)
        else props.onExpand(!expanded)
      }} />
    {step.body?.kind === 'commit' && <StepBody ports={props.ports} body={step.body} sessionId={props.sessionId} title={step.title} visible={props.visible}
      conflicts={props.ports.conflicts} onReview={props.onReview} busy={props.busy} />}
    {step.body !== undefined && step.body.kind !== 'commit' && <button ref={detailsToggle} type="button" className="session-actions__toggle" aria-expanded={expanded}
      onClick={() => props.onExpand(!expanded)}>{expanded ? 'Hide details' : 'Show details'}: {step.title}</button>}
    {expanded && step.body !== undefined && step.body.kind !== 'commit' && <div className="session-actions__body">
      <StepBody ports={props.ports} body={step.body} sessionId={props.sessionId} title={step.title} visible={props.visible} conflicts={props.ports.conflicts}
        onClose={() => { props.onExpand(false); detailsToggle.current?.focus() }} />
    </div>}
  </>
}

/**
 * New steps and output land at the end, so the pane follows them while the person reads the end.
 * Scrolling up stops the following; scrolling back to the end resumes it.
 */
export class SessionActionsScroll {
  static readonly endSlackPxConst = 24

  static useFollowEnd(element: HTMLElement | null): void {
    useEffect(() => {
      if (element === null) return
      let following = true
      const onScroll = (): void => {
        following = element.scrollHeight - element.scrollTop - element.clientHeight <= SessionActionsScroll.endSlackPxConst
      }
      const follow = (): void => { if (following) element.scrollTop = element.scrollHeight }
      const observer = new MutationObserver(follow)
      observer.observe(element, { childList: true, subtree: true, characterData: true })
      element.addEventListener('scroll', onScroll)
      follow()
      return () => {
        observer.disconnect()
        element.removeEventListener('scroll', onScroll)
      }
    }, [element])
  }
}
