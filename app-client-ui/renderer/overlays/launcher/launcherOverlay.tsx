import { useEffect, useRef, useState } from 'react'

import type { TerminalTarget } from '../../../shared/terminalTarget'
import type { PanelOpenOutcome } from '../../shell/appShell.types'
import {
  type ComputersScreenInput,
  ComputersScreenModel,
  type ComputersScreenState,
} from './computers/computersScreenModel'
import { LauncherComputersScreen } from './computers/launcherComputersScreen'
import {
  type CreateScreenInput,
  CreateScreenModel,
  type CreateScreenState,
} from './create/createScreenModel'
import { CreateTypes, LauncherCreateScreen } from './create/launcherCreateScreen'
import { FlowCatalog } from './flows/flowCatalog'
import { LauncherFlowScreen } from './flows/launcherFlowScreen'
import { FlowScreenModel, type FlowScreenState } from './flows/flowScreenModel'
import './launcher.css'
import { LauncherEffects, type LauncherPorts } from './launcherEffects'
import type { LauncherBinding } from './launcherBinding'
import type { LauncherIntentStore, LauncherPrefill } from './launcherIntentStore'
import type { LauncherRemoteTarget, LauncherTarget } from './launcherTarget'
import { type LauncherInput, LauncherModel, type LauncherState } from './projects/launcherModel'
import { LauncherProjectsScreen, NewProjectEdit } from './projects/launcherProjectsScreen'
import { ManageStrip } from './projects/manageStrip'
import {
  type ManageInput,
  ManageModel,
  type ManageOperation,
  type ManageState,
} from './projects/manageModel'
import { ProjectSummaryLoader, type SummaryRequest } from './projects/projectSummaries'

/**
 * Which screen the card is showing. A union rather than one nullable state per screen: three screens
 * would be eight combinations of which only three are legal, and nothing would be enforcing that.
 */
type LauncherScreen =
  | { kind: 'computers'; state: ComputersScreenState }
  | { kind: 'projects' }
  | { kind: 'create'; state: CreateScreenState }
  | { kind: 'flow'; state: FlowScreenState }

type LauncherScreenKind = LauncherScreen['kind']

/** The member of the union a given kind names, so a descriptor sees only its own screen's state. */
type ScreenOf<K extends LauncherScreenKind> = Extract<LauncherScreen, { kind: K }>

/**
 * What Tab does on a screen. Three fixed behaviours rather than a callback: every screen picks one of
 * these, and a fourth would be a decision somebody has to make rather than a function somebody can
 * quietly write.
 *
 * `category` steps the category tabs, which is what Tab means on the screen that has them. `agent`
 * cycles the agent. `focus` walks the controls INSIDE the card and wraps, for a screen that is a
 * form - a Tab let through to the browser would take focus out of an overlay the user cannot see
 * they have left.
 */
type LauncherScreenTab = 'category' | 'agent' | 'focus'

/**
 * Everything a launcher screen answers for, in one place per screen.
 *
 * Adding a screen used to mean editing six unlinked sites - the ports closure, the body render,
 * the title, the key line, four arms inside the key handler and three effect runners - of which only
 * the union was linked. Two of the six were already wrong for the newest screen when this was
 * written. A screen missing from the catalog below now fails the compile.
 */
interface LauncherScreenDescriptor<K extends LauncherScreenKind> {
  /** What the header says while this screen is up, and which computer it is about. */
  titleOf(screen: ScreenOf<K>, state: LauncherState): string
  /** The key line under it, which for one screen is drawn from the state rather than fixed. */
  footKeysOf(screen: ScreenOf<K>, state: LauncherState, manage: ManageState): readonly FootHint[]
  /** What the body draws. */
  render(screen: ScreenOf<K>, state: LauncherState, ports: LauncherPorts): React.JSX.Element
  tab: LauncherScreenTab
  /** Escape, which on every screen but one is that screen's own input. */
  escape(ports: LauncherPorts, manage: ManageState): void
  /** Enter, once the flow screen's textarea rule has been applied. */
  enter(ports: LauncherPorts, manage: ManageState): void
  /**
   * The bare letters and arrows this screen answers, after Tab, Escape and Enter have been taken.
   * A screen that answers none of them says so by doing nothing - never by being the arm the others
   * fall through to, which is how one screen inherited another's `F2 a a` and archived a project it
   * was not showing.
   */
  press(
    event: React.KeyboardEvent,
    screen: ScreenOf<K>,
    ports: LauncherPorts,
    context: { state: LauncherState; manage: ManageState; card: HTMLElement | null },
  ): void
}

/**
 * The one surface this shell draws over the workspace.
 *
 * It is deliberately not a panel: it has no registry key, it is not serialized into a saved layout
 * and it never comes back after a restart. That is why the shell owns whether it is open instead of
 * the tab engine - there is nothing here for a layout to remember.
 *
 * It owns the I/O and the models own the decisions. Every model is read through a ref rather than
 * through the rendered state, because a burst of dispatches in one tick has to see what the one
 * before it decided, not what React has drawn.
 *
 * Three screens live here: the projects the shell knows, what to start or continue in the one that
 * was picked, and a flow's own form. Which is up is this component's own fact, held as one union so
 * that "two screens at once" is not a state that can be reached.
 */
/** What a flow's own form is, from the model that owns it: this file never reads inside it. */
type LauncherScreenFlowForm = FlowScreenState['form']

export function LauncherOverlay(props: {
  intents: LauncherIntentStore
  /**
   * What a created session is drawn in. The card closes right after, so this runs before it does.
   * A target rather than a session id: a session founded on another computer is drawn by the same
   * tab, reached through that computer's endpoint.
   */
  onOpenTerminal(
    target: TerminalTarget,
    title: string,
    options?: { plain?: true; preview?: true },
  ): Promise<PanelOpenOutcome>
  /** Where a computer this card does not list is explained. It replaces this card. */
  onOpenRemoteSettings(): void
  onClose(): void
}): React.JSX.Element {
  const card = useRef<HTMLDivElement | null>(null)
  /** Set when a terminal was opened from here: focus belongs to that tab, not to whatever opened this. */
  const handedOff = useRef(false)
  // One shot, read while the surface is being built: an intent is what ONE keystroke meant, and a
  // launcher opened again later must not still be acting on it. Read BEFORE the machine below,
  // which starts in the category the intent named.
  const [intent] = useState(() => props.intents.consume())
  // Read once and held for the life of the card, not for the life of one screen: Escape back to the
  // projects and Enter again is still the tab card, or still the network card.
  const tabProfile = intent?.purpose === 'tabProfile'
  const remoteProfile = intent?.purpose === 'remote'
  const [start] = useState(() => LauncherModel.initial(
    remoteProfile ? null : intent?.category ?? null,
    remoteProfile ? intent?.remote ?? null : null,
  ))
  // Ctrl+N knows no computer and asks; the tree's action on a paired computer already knows, so
  // that card opens where the local one does - on the projects of the machine it names.
  const [computersStart] = useState(() => ComputersScreenModel.initial())
  const [opening] = useState<LauncherScreen>(() => (remoteProfile && intent?.remote === undefined
    ? { kind: 'computers', state: computersStart.state }
    : { kind: 'projects' }))
  const [state, setState] = useState<LauncherState>(start.state)
  const [manage, setManage] = useState<ManageState>(() => ManageModel.initial())
  const [screen, setScreen] = useState<LauncherScreen>(opening)
  const stateRef = useRef<LauncherState>(start.state)
  const manageRef = useRef<ManageState>(manage)
  const screenRef = useRef<LauncherScreen>(opening)
  const agentPreference = useRef<{
    ready: boolean
    agentId: CreateScreenState['agentId']
  }>({ ready: false, agentId: 'claude' })
  /** A binding chosen before the stored agent arrived, with whatever the opener said about it. */
  const pendingBinding = useRef<{
    binding: LauncherBinding
    prefill: LauncherPrefill | null
  } | null>(null)
  /**
   * The last form typed into each flow, so Escape is a way back rather than a way to lose a
   * paragraph. It is a ref and not state: nothing draws from it, and re-rendering the card every
   * keystroke to keep a copy nobody reads is work for its own sake.
   */
  const flowForms = useRef(new Map<string, LauncherScreenFlowForm>())
  const closeRef = useRef(props.onClose)
  closeRef.current = props.onClose
  const openTerminalRef = useRef(props.onOpenTerminal)
  openTerminalRef.current = props.onOpenTerminal
  const openRemoteSettingsRef = useRef(props.onOpenRemoteSettings)
  openRemoteSettingsRef.current = props.onOpenRemoteSettings

  const [summaries] = useState(() => new ProjectSummaryLoader(async (categoryId, name) => {
    const answer = await window.appClient.projects.sessions(categoryId, name)
    if (!answer.ok || !answer.value.ok)
      return null
    return answer.value.value
  }))
  const [ports] = useState<LauncherPorts>(() => {
    const self: LauncherPorts = {
      dispatch: (input) => {
        const step = LauncherModel.transition(stateRef.current, input)
        stateRef.current = step.state
        setState(step.state)
        for (const effect of step.effects)
          void LauncherEffects.run(effect, self)
        // The actions belong to the row the cursor is on, so moving the cursor moves them - and
        // abandons whatever was half-started on the row being left.
        LauncherOverlayRows.syncTarget(step.state, manageRef.current, self)
      },
      manage: (input) => {
        const step = ManageModel.transition(manageRef.current, input)
        manageRef.current = step.state
        setManage(step.state)
        for (const effect of step.effects) {
          // A moved project's counts are about a path that no longer holds.
          if (effect.effect === 'refetchProjects')
            summaries.invalidate({ categoryId: effect.categoryId, name: effect.name })
          void LauncherEffects.runManage(effect, self)
        }
      },
      computers: (input) => {
        // The list refreshes itself whenever that snapshot moves, so an answer can land after the
        // screen has been left. Nothing to tell then, and nothing to throw about.
        const current = screenRef.current
        if (current.kind !== 'computers')
          return
        const step = ComputersScreenModel.transition(current.state, input)
        screenRef.current = { kind: 'computers', state: step.state }
        setScreen(screenRef.current)
        for (const effect of step.effects)
          void LauncherEffects.runComputers(effect, self)
      },
      create: (input) => {
        // A number read or a create can answer after Escape took the screen away. That is a late
        // answer, not a fault: there is nothing left to tell, and a throw here would surface as an
        // unhandled rejection from a card the user has already left.
        const current = screenRef.current
        if (current.kind !== 'create')
          return
        const step = CreateScreenModel.transition(current.state, input)
        if (step.state.agentId !== current.state.agentId) {
          agentPreference.current = { ready: true, agentId: step.state.agentId }
          void LauncherEffects.saveNewSessionAgent(step.state.agentId)
        }
        screenRef.current = { kind: 'create', state: step.state }
        setScreen(screenRef.current)
        for (const effect of step.effects)
          void LauncherEffects.runCreate(effect, screenRef.current.state, self)
      },
      // Enter on a project means one thing again: start a session in it. It meant two while the
      // manage mode existed - in the mode it pointed the actions at the row instead - and `from` was
      // how the mouse kept meaning open. The actions have their own keys now, so nothing branches.
      chooseBinding: (binding, prefill) => {
        if (!agentPreference.current.ready) {
          pendingBinding.current = { binding, prefill: prefill ?? null }
          return
        }
        pendingBinding.current = null
        const step = CreateScreenModel.opened(binding, {
          tabProfile: tabProfile ? true : undefined,
          // What the clicked session runs beats what was last started from the launcher: the
          // preference answers "which agent do I usually start", and this card was opened on one
          // that has already answered it.
          agentId: prefill?.agentId ?? agentPreference.current.agentId,
          target: LauncherOverlayTarget.of(stateRef.current.remote),
          ...(prefill?.name === undefined ? {} : { name: prefill.name }),
          ...(prefill?.session === undefined ? {} : { source: prefill.session }),
        })
        screenRef.current = { kind: 'create', state: step.state }
        setScreen(screenRef.current)
        for (const effect of step.effects)
          void LauncherEffects.runCreate(effect, step.state, self)
      },
      // A flow is configured before it starts, and what the create screen already answered travels
      // with it: the flow proposes a title and an isolation, and what the person chose one screen
      // back still wins over the proposal.
      openFlow: (flowId, options) => {
        // What was typed into this flow last time, if the card has been open once already.
        const step = FlowScreenModel.opened(flowId, options, flowForms.current.get(flowId))
        screenRef.current = { kind: 'flow', state: step.state }
        setScreen(screenRef.current)
        for (const effect of step.effects)
          void LauncherEffects.runFlow(effect, step.state, self)
      },
      flow: (input) => {
        const current = screenRef.current
        if (current.kind !== 'flow')
          return
        const step = FlowScreenModel.transition(current.state, input)
        // Kept on every step rather than only on the way out: a submit that is refused leaves
        // the same screen up, and this is what Escape after it goes back to.
        flowForms.current.set(step.state.flowId, step.state.form)
        screenRef.current = { kind: 'flow', state: step.state }
        setScreen(screenRef.current)
        for (const effect of step.effects)
          void LauncherEffects.runFlow(effect, screenRef.current.state, self)
      },
      showCreate: (options) => {
        screenRef.current = { kind: 'create', state: { ...options, submitting: false } }
        setScreen(screenRef.current)
      },
      showProjects: () => {
        screenRef.current = { kind: 'projects' }
        setScreen(screenRef.current)
      },
      // The chosen computer starts the projects screen over rather than filtering the one that is
      // there: a catalog belongs to one machine, and half of another machine's listing left on
      // screen would be a project row that opens nothing.
      chooseComputer: (target) => {
        const step = LauncherModel.initial(null, target)
        stateRef.current = step.state
        setState(step.state)
        screenRef.current = { kind: 'projects' }
        setScreen(screenRef.current)
        for (const effect of step.effects)
          void LauncherEffects.run(effect, self)
      },
      // Fresh every time rather than the list this card started with: which computers are connected
      // is exactly the thing that changes while a card is open.
      showComputers: () => {
        const step = ComputersScreenModel.initial()
        screenRef.current = { kind: 'computers', state: step.state }
        setScreen(screenRef.current)
        for (const effect of step.effects)
          void LauncherEffects.runComputers(effect, self)
      },
      openRemoteSettings: () => {
        closeRef.current()
        openRemoteSettingsRef.current()
      },
      openTerminal: (target, title, options) =>
        openTerminalRef.current(target, title, options),
      markHandedOff: () => { handedOff.current = true },
      close: () => closeRef.current(),
    }
    return self
  })

  // Whoever had focus gets it back. An overlay that opens on a keystroke and returns focus nowhere
  // leaves a keyboard user at the top of the document with no way back to what they were reading.
  // Unless this card handed focus on: a session that was just created is drawn in a terminal somebody
  // is about to type into, and giving the caret back to the button that opened the card would make
  // them click into it first.
  useEffect(() => {
    const restore = document.activeElement
    card.current?.focus()
    if (opening.kind === 'projects' && !intent?.prefill)
      ports.dispatch({ input: 'searchOpen' })
    return () => {
      if (!handedOff.current && restore instanceof HTMLElement)
        restore.focus()
    }
  }, [])

  useEffect(() => {
    let disposed = false
    void LauncherEffects.loadNewSessionAgent().then((agentId) => {
      if (disposed) return
      agentPreference.current = { ready: true, agentId }
      const pending = pendingBinding.current
      if (pending !== null)
        ports.chooseBinding(pending.binding, pending.prefill ?? undefined)
    })
    return () => { disposed = true }
  }, [ports])

  // A button that is clicked and then taken away leaves focus on the document body: the delete
  // replaces its four buttons with a preview, and the preview with a report. The card's keydown is
  // the only listener this surface has, so from there Escape reached nothing. Removing the focused
  // element announces nothing - no blur, no focusout - so this is answered after the commit rather
  // than from a listener. No dependency list on purpose: what it guards is the DOM after a commit,
  // which no value here describes.
  //
  // It answers focus lost to NOTHING, and never focus that something else legitimately holds. The
  // settings card `Ctrl+,` opens over this one is exactly that: a guard that asked only "is it
  // inside me" pulled the caret back out of it on the next summary that arrived. The hand-off is
  // the same case - the terminal that was just opened is where somebody is about to type.
  useEffect(() => {
    const element = card.current
    if (handedOff.current || !element)
      return
    const active = document.activeElement
    if (active === null || active === document.body)
      element.focus()
  })

  useEffect(() => {
    if (opening.kind === 'computers') {
      // The projects model was built for a computer nobody has named yet, so its own first read is
      // deliberately not run: `chooseComputer` builds it again once there is a machine to read.
      for (const effect of computersStart.effects)
        void LauncherEffects.runComputers(effect, ports)
      return
    }
    for (const effect of start.effects)
      void LauncherEffects.run(effect, ports)
    // An opener that already knew where skips the screen that picks one: from a project node in
    // the tree, a new session stays two keystrokes away, and from a session row the card opens
    // holding that session's own name and agent as well.
    if (intent?.prefill)
      ports.chooseBinding(intent.prefill.binding, intent.prefill)
  }, [start, opening, computersStart, ports, intent])

  /*
   * Losing the computer this card is aimed at is a normal state, not a fault: the row goes from the
   * list, the form stays holding what was typed, and the card says why nothing can start from it.
   * Without this the only way to find out was to press Enter and read a transport error.
   */
  useEffect(() => {
    if (!remoteProfile) return
    return window.appClient.onRemoteChanged(() => {
      if (screenRef.current.kind === 'computers')
        return void LauncherEffects.runComputers({ effect: 'fetchComputers' }, ports)
      const target = stateRef.current.remote
      if (target === null) return
      void LauncherEffects.readRemoteSnapshot().then((snapshot) => {
        if (snapshot === null) return
        const endpoint = snapshot.outbound
          .find((candidate) => candidate.remoteEndpointId === target.remoteEndpointId)
        if (endpoint !== undefined && endpoint.status === 'connected') return
        ports.dispatch({
          input: 'loadFailed',
          detail: `${target.displayName} is no longer connected.`,
        })
        ports.create({ input: 'targetLost' })
      })
    })
  }, [remoteProfile, ports])

  const visible = LauncherOverlayRows.visibleOf(state)
  // Keyed by which rows are on screen, not by the state: moving the cursor must not supersede a
  // batch that is halfway through reading the projects it is standing among.
  const visibleKey = visible.map((request) => `${request.categoryId}/${request.name}`).join('\n')
  useEffect(() => {
    summaries.load(visible, (request, summary) => ports.dispatch({
      input: 'summaryLoaded',
      categoryId: request.categoryId,
      name: request.name,
      summary,
    }))
    // `visible` is rebuilt on every render and `visibleKey` is what actually changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleKey, summaries, ports])

  return (
    <div
      className="jamat-launcher"
      // The backdrop closes and the card does not, so the press must have landed on the backdrop
      // itself. mousedown rather than click: a drag that starts inside the card and ends outside it
      // is a text selection, not a request to close.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget)
          props.onClose()
      }}
    >
      <div
        className={`jamat-launcher__card${
          screen.kind === 'create' && CreateScreenModel.typeOf(screen.state).kind === 'existing'
            ? ' jamat-launcher__card--wide'
            : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={LauncherScreens.titleOf(screen, state)}
        tabIndex={-1}
        ref={card}
        // The only keydown of this surface, and it is on the card. A second listener on the document
        // is how V1 ran every command twice.
        onKeyDown={(event) => LauncherKeys.handle(
          event, stateRef.current, manageRef.current, screenRef.current, ports, card.current,
        )}
      >
        <header className="jamat-launcher__head">
          <span className="jamat-launcher__title">{LauncherScreens.titleOf(screen, state)}</span>
          <button
            className="jamat-launcher__close"
            type="button"
            aria-label="Close Projects"
            onClick={props.onClose}
          >
            ×
          </button>
        </header>
        <div className="jamat-launcher__body">
          {LauncherScreens.render(screen, state, ports)}
        </div>
        {/* Beside the key line rather than inside the body, which scrolls: at the end of a long list
            a strip would open below the fold and the key that opened it would look like it did
            nothing. Above it, because that line is the open strip's own legend. One at a time - the
            keys that would open the second are not live while the first is up, and the line says so. */}
        {screen.kind === 'projects' && state.newProject !== null && (
          <NewProjectEdit
            name={state.newProject.name}
            place={LauncherModel.placeLabelOf(state)}
            onChanged={(name) => ports.dispatch({ input: 'newProjectChanged', name })}
          />
        )}
        {screen.kind === 'projects' && state.newProject === null && ManageModel.hasStrip(manage) && (
          <ManageStrip
            manage={manage}
            folders={LauncherModel.foldersOf(state)}
            now={Date.now()}
            dispatch={ports.manage}
          />
        )}
        {/* Every hint that names an action IS that action: the click sends the input the key sends,
            so the mouse can do whatever the keyboard can without a second code path to drift. The
            ones that name no action - the arrows - stay text. */}
        <footer className="jamat-launcher__foot">
          {LauncherScreens.footKeysOf(screen, state, manage).map((hint) => (hint.press === null
            ? (
              <span key={hint.key}>
                <span className="jamat-launcher__key">{hint.key}</span> {hint.label}
              </span>
            )
            : (
              <button
                key={hint.key}
                className="jamat-launcher__foot-key"
                type="button"
                onClick={() => LauncherFootKeys.press(hint, screen, ports, manage)}
              >
                <span className="jamat-launcher__key">{hint.key}</span> {hint.label}
              </button>
            )))}
        </footer>
      </div>
    </div>
  )
}

/**
 * What the footer offers is what the keys do at that moment, and in manage mode that changes with
 * every step: a line naming R while a rename edit is open would name a key that types a letter into
 * it.
 */
class LauncherScreens {
  /**
   * One descriptor per screen. The `satisfies` is the whole point: a kind added to `LauncherScreen`
   * with no entry here stops the compile, which is what six hand-written sites could not do.
   */
  private static readonly catalogConst = {
    computers: {
      titleOf: () => 'Remote computers',
      footKeysOf: () => LauncherFootKeys.legend([
        ['Esc', 'Close'],
        ['↑↓', 'Row'],
        ['Enter', 'Choose'],
      ]),
      render: (screen, _state, ports) => (
        <LauncherComputersScreen state={screen.state} dispatch={ports.computers} />
      ),
      // The empty state carries a button, and it is the only thing here Tab can reach.
      tab: 'focus',
      escape: (ports) => ports.computers({ input: 'escape' }),
      enter: (ports) => ports.computers({ input: 'activate' }),
      press: (event, _screen, ports) => {
        const chosen = LauncherKeys.computersInputOf(event.key)
        if (!chosen)
          return
        event.preventDefault()
        ports.computers(chosen)
      },
    } satisfies LauncherScreenDescriptor<'computers'>,

    projects: {
      titleOf: (_screen, state) => (state.remote === null
        ? 'Projects'
        : `Projects on ${state.remote.displayName}`),
      footKeysOf: (_screen, state, manage) => LauncherFootKeys.projectsKeys(state, manage),
      render: (_screen, state, ports) => (
        <LauncherProjectsScreen state={state} now={Date.now()} dispatch={ports.dispatch} />
      ),
      tab: 'category',
      escape: (ports, manage) => {
        // An open operation is the innermost thing on screen and belongs to the other model.
        // Everything below it is the launcher's own ladder, which `LauncherModel.escaped` peels in
        // its own order: the name being typed, then the filter, then the folder, and the card last.
        if (manage.operation)
          return ports.manage({ input: 'cancel' })
        ports.dispatch({ input: 'escape' })
      },
      enter: (ports, manage) => {
        if (manage.operation?.op === 'rename')
          return ports.manage({ input: 'renameConfirm' })
        ports.dispatch({ input: 'activate' })
      },
      press: (event, _screen, ports, context) =>
        LauncherKeys.projectsKey(event, context.state, context.manage, ports),
    } satisfies LauncherScreenDescriptor<'projects'>,

    create: {
      titleOf: (screen, state) => {
        if (screen.state.tabProfile) return 'New tab'
        return state.remote === null
          ? 'New session'
          : `New session on ${state.remote.displayName}`
      },
      /*
       * Type-driven in both profiles, because both now draw the type row. The last hint follows the
       * choice rather than naming both: what Enter does here is exactly one of them, and a footer
       * that says otherwise is a footer nobody trusts. The tab card drops `W`, the one key its rows
       * do not carry.
       */
      footKeysOf: (screen) => {
        const type = CreateScreenModel.typeOf(screen.state)
        // Continue/Fork says both its words until a row settles which, and only one of its rows has
        // a name to type: a fork founds a session that is still to be called something.
        if (type.kind === 'existing') {
          const acting = CreateScreenModel.actingOn(screen.state)
          return LauncherFootKeys.legend([
            ['Esc', 'Back'],
            ['↑↓', 'Row'],
            ['←→', 'Choose'],
            ['Enter', CreateTypes.submitLabelOf(type, acting)],
            ...(acting?.mode === 'fork' ? [['N', 'Name'] as const] : []),
            ['Tab', 'Agent filter'],
          ])
        }
        else if (type.kind === 'flow' || type.kind === 'raw' || type.kind === 'shell')
          return LauncherFootKeys.legend([
            ['Esc', 'Back'],
            ['↑↓', 'Row'],
            ['←→', 'Choose'],
            ['Enter', type.kind === 'flow' ? 'Configure' : 'Start'],
            ['Tab', 'Agent'],
            ...(screen.state.tabProfile
              ? []
              : [['W', 'Worktree'] as const]),
            ['N', 'Name'],
          ])
        else
          throw new Error(`Unknown create type: ${JSON.stringify(type)}`)
      },
      render: (screen, _state, ports) => (
        <LauncherCreateScreen state={screen.state} dispatch={ports.create} />
      ),
      tab: 'agent',
      escape: (ports) => ports.create({ input: 'escape' }),
      enter: (ports) => ports.create({ input: 'activate' }),
      press: (event, _screen, ports) => {
        const chosen = LauncherKeys.createInputOf(event.key)
        if (!chosen)
          return
        event.preventDefault()
        ports.create(chosen)
      },
    } satisfies LauncherScreenDescriptor<'create'>,

    flow: {
      titleOf: (screen) => FlowCatalog.byId(screen.state.flowId).title,
      // All fields, so it names only the two keys that are not typing.
      footKeysOf: () => LauncherFootKeys.legend([['Esc', 'Back'], ['Enter', 'Start session']]),
      render: (screen, _state, ports) => (
        <LauncherFlowScreen state={screen.state} dispatch={ports.flow} />
      ),
      /*
       * A FORM - a summary and two textareas - so Tab has to move between them, and swallowing it
       * left a keyboard user able to fill the first field and nothing else, in an overlay whose
       * whole premise is that every action names its key.
       */
      tab: 'focus',
      escape: (ports) => ports.flow({ input: 'escape' }),
      enter: (ports) => ports.flow({ input: 'activate' }),
      // Enter and Escape are the flow's only keys and both are taken before this runs.
      press: () => undefined,
    } satisfies LauncherScreenDescriptor<'flow'>,
  } satisfies { [K in LauncherScreenKind]: LauncherScreenDescriptor<K> }

  /**
   * The descriptor for the screen in front.
   *
   * The `as never` is the one thing TypeScript will not do here: it cannot correlate `screen.kind`
   * with the entry the map holds under that key, so every descriptor method would see the whole
   * union rather than its own member. What the cast promises is checked either side of it - the map
   * `satisfies` one descriptor per kind, and each descriptor names the screen type it is written
   * for - so the only thing unproven is the correlation, and the map is keyed BY that correlation.
   */
  private static of(screen: LauncherScreen): LauncherScreenDescriptor<LauncherScreenKind> {
    return LauncherScreens.catalogConst[screen.kind] as
      LauncherScreenDescriptor<LauncherScreenKind>
  }

  static titleOf(screen: LauncherScreen, state: LauncherState): string {
    return LauncherScreens.of(screen).titleOf(screen as never, state)
  }

  static footKeysOf(
    screen: LauncherScreen,
    state: LauncherState,
    manage: ManageState,
  ): readonly FootHint[] {
    return LauncherScreens.of(screen).footKeysOf(screen as never, state, manage)
  }

  static render(
    screen: LauncherScreen,
    state: LauncherState,
    ports: LauncherPorts,
  ): React.JSX.Element {
    return LauncherScreens.of(screen).render(screen as never, state, ports)
  }

  static tabOf(screen: LauncherScreen): LauncherScreenTab {
    return LauncherScreens.of(screen).tab
  }

  static escape(screen: LauncherScreen, ports: LauncherPorts, manage: ManageState): void {
    LauncherScreens.of(screen).escape(ports, manage)
  }

  static enter(screen: LauncherScreen, ports: LauncherPorts, manage: ManageState): void {
    LauncherScreens.of(screen).enter(ports, manage)
  }

  static press(
    event: React.KeyboardEvent,
    screen: LauncherScreen,
    ports: LauncherPorts,
    context: { state: LauncherState; manage: ManageState; card: HTMLElement | null },
  ): void {
    LauncherScreens.of(screen).press(event, screen as never, ports, context)
  }
}

/**
 * What clicking a hint does. A descriptor rather than a closure, so `of` stays a pure function of the
 * state and a test can assert that the hint named `F8` carries the input `F8` sends.
 */
type FootPress =
  | { to: 'launcher'; input: LauncherInput }
  | { to: 'manage'; input: ManageInput }
  /** The one that is not a single input: Escape peels a ladder across both models and the card. */
  | { to: 'escape' }

interface FootHint {
  key: string
  label: string
  /** Null where the hint names no single action, which is every hint made of arrows. */
  press: FootPress | null
}

class LauncherFootKeys {
  /**
   * Only the projects screen's line is clickable. The other three carry their own controls - the
   * start button, the mode cards, the form - so a second way to press them would be a second code
   * path for something already on screen.
   */
  static projectsKeys(state: LauncherState, manage: ManageState): readonly FootHint[] {
    // An open strip owns the line: it is the strip's legend while it is up, and the keys that would
    // open the other one are not live under it.
    if (state.newProject !== null)
      return [
        { key: 'Enter', label: 'Create project', press: { to: 'launcher', input: { input: 'activate' } } },
        { key: 'Esc', label: 'Cancel the edit', press: { to: 'escape' } },
      ]
    const operation = manage.operation
    if (operation !== null)
      return LauncherFootKeys.operationKeys(operation)
    return LauncherFootKeys.browseKeys(state, manage)
  }

  /**
   * The whole line of the projects screen, declared once in the order it is read: the way out, then
   * every function key ascending, with a shifted one directly after the key it shares. Sorted numerically because the eye looks for `F6` between `F4` and `F7` rather than at
   * whichever end of the line the code happened to build it - they were grouped by what they act on
   * before, which put `F6` first and `F4` fifth.
   *
   * `needsProject` is the second rule and stays a flag rather than a second list, so the order lives
   * in one place. Those five would name keys that answer nothing on a folder row and on the two tail
   * rows, and ten hints on one line is enough without the ones that do not apply.
   */
  private static browseKeys(state: LauncherState, manage: ManageState): readonly FootHint[] {
    const hints: readonly (FootHint & { needsProject?: true; needsLocal?: true })[] = [
      { key: 'Esc', label: LauncherFootKeys.escapeLabelOf(state), press: { to: 'escape' } },
      { key: 'F1', label: 'Search', press: { to: 'launcher', input: { input: 'searchOpen' } } },
      {
        key: 'F3',
        label: state.view === 'grouped' ? 'Grouped' : 'Flat',
        press: { to: 'launcher', input: { input: 'toggleView' } },
      },
      {
        key: 'F4',
        label: `Sort: ${state.sort}`,
        press: { to: 'launcher', input: { input: 'cycleSort' } },
      },
      {
        key: 'F6',
        label: 'Rename',
        press: { to: 'manage', input: { input: 'renameStart' } },
        needsProject: true,
      },
      {
        key: '⇧F6',
        label: 'Move',
        press: { to: 'manage', input: { input: 'movePrefixStart' } },
        needsProject: true,
      },
      {
        key: 'F7',
        label: 'Create project',
        press: { to: 'launcher', input: { input: 'newProjectStart' } },
        needsLocal: true,
      },
      {
        key: 'F8',
        label: 'Archive',
        press: { to: 'manage', input: { input: 'archiveStart' } },
        needsProject: true,
      },
      {
        key: '⇧F8',
        label: 'Delete…',
        press: { to: 'manage', input: { input: 'deleteStart' } },
        needsProject: true,
      },
    ]
    // A remote card aims the manage actions at nothing, so `needsProject` already takes those four
    // off the line; the create is the one that would otherwise stay and make a directory here.
    const local = hints.filter((hint) => state.remote === null || hint.needsLocal !== true)
    if (manage.target !== null)
      return local
    return local.filter((hint) => hint.needsProject !== true)
  }

  private static operationKeys(operation: ManageOperation): readonly FootHint[] {
    if (operation.op === 'rename')
      return [
        { key: 'Enter', label: 'Confirm', press: { to: 'manage', input: { input: 'renameConfirm' } } },
        { key: 'Esc', label: 'Cancel the edit', press: { to: 'escape' } },
      ]
    else if (operation.op === 'movePrefix')
      return [{ key: 'Esc', label: 'Cancel', press: { to: 'escape' } }]
    else if (operation.op === 'archive')
      return [
        { key: 'F8', label: 'Confirm the archive', press: { to: 'manage', input: { input: 'archiveStart' } } },
        { key: 'Esc', label: 'Cancel', press: { to: 'escape' } },
      ]
    // The delete confirms on its own button and nowhere else: the button carries the file count, and
    // no key can carry a number the user has read.
    else if (operation.op === 'delete')
      return [{ key: 'Esc', label: 'Cancel', press: { to: 'escape' } }]
    else
      throw new Error(`Unknown manage operation: ${JSON.stringify(operation)}`)
  }

  static legend(pairs: readonly (readonly [string, string])[]): readonly FootHint[] {
    return pairs.map(([key, label]) => ({ key, label, press: null }))
  }

  /** The click and the key reach the same model through the same input, or they are two behaviours. */
  static press(
    hint: FootHint,
    screen: LauncherScreen,
    ports: LauncherPorts,
    manage: ManageState,
  ): void {
    const press = hint.press
    if (press === null) return
    else if (press.to === 'launcher') ports.dispatch(press.input)
    else if (press.to === 'manage') ports.manage(press.input)
    else if (press.to === 'escape') LauncherScreens.escape(screen, ports, manage)
    else
      throw new Error(`Unknown foot press: ${JSON.stringify(press)}`)
  }

  /**
   * The rungs `LauncherModel.escaped` peels, read out in its order. The footer modelled three of the
   * four and named the last one whatever was open above it: with a filter typed at the root it
   * offered `Close` while Escape was clearing the filter. The edit is the rung above these and is
   * answered by the caller, which returns before it reaches here.
   */
  private static escapeLabelOf(state: LauncherState): string {
    if (state.search.text.length > 0)
      return 'Clear the filter'
    if (state.virtualFolderPrefix !== null)
      return 'Leave folder'
    // The rung below a remote catalog is the computer list, not the way out.
    return state.remote === null ? 'Close' : 'Computers'
  }
}

/** The one place the projects screen's computer becomes the create screen's target. */
class LauncherOverlayTarget {
  static of(remote: LauncherRemoteTarget | null): LauncherTarget {
    return remote === null ? { kind: 'local' } : { kind: 'remote', ...remote }
  }
}

class LauncherOverlayRows {
  /**
   * How far down the list the counts are fetched. One call per row reads a project's whole history
   * the first time, so a root with two hundred projects would otherwise spend two hundred reads on
   * rows nobody has scrolled to.
   */
  private static readonly visibleConst = 30

  static visibleOf(state: LauncherState): readonly SummaryRequest[] {
    // The counts are read from this machine's own records, so a remote catalog draws none rather
    // than drawing local numbers beside another computer's project names.
    if (state.remote !== null) return []
    return LauncherModel.rowsOf(state)
      .flatMap((row) => (row.kind === 'project'
        ? [{ categoryId: row.categoryId, name: row.project.name }]
        : []))
      .slice(0, LauncherOverlayRows.visibleConst)
  }

  static syncTarget(state: LauncherState, manage: ManageState, ports: LauncherPorts): void {
    // Renaming, moving, archiving and deleting all act on a directory of THIS machine. Aiming them
    // at a row of another computer's catalog is how a project here gets archived by a card that was
    // showing a project there, so a remote card aims them at nothing at all.
    if (state.remote !== null) {
      if (manage.target !== null)
        ports.manage({ input: 'untarget' })
      return
    }
    const row = LauncherModel.rowsOf(state)[state.cursor]
    if (!row || row.kind !== 'project') {
      // Standing on a folder or on the create row: leaving the actions on the project below would
      // offer a delete for something the cursor is not on.
      if (manage.target !== null)
        ports.manage({ input: 'untarget' })
      return
    }
    if (manage.target?.categoryId === row.categoryId
      && manage.target.projectName === row.project.name)
      return
    ports.manage({
      input: 'aim',
      target: { categoryId: row.categoryId, projectName: row.project.name },
    })
  }
}

class LauncherKeys {
  /** What a Tab may land on inside the card, in the order the eye reads them. */
  private static readonly focusableConst =
    'input:not([disabled]), textarea:not([disabled]), select:not([disabled]), '
    + 'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'

  /**
   * Focus to the next or previous control inside the card, wrapping at both ends.
   *
   * Written here rather than left to the browser because the card is a modal: the browser's own
   * Tab walks out of it at the last control, into a document the user cannot see, and back is
   * then a Tab through everything behind the overlay.
   */
  private static stepFocus(card: HTMLElement | null, delta: 1 | -1): void {
    if (card === null) return
    const stops = [...card.querySelectorAll<HTMLElement>(LauncherKeys.focusableConst)]
    if (stops.length === 0) return
    const active = document.activeElement
    const at = stops.findIndex((stop) => stop === active)
    // Nothing of the card has focus yet - the card itself does - so Tab starts at the first
    // control and Shift+Tab at the last.
    const next = at === -1
      ? (delta === 1 ? 0 : stops.length - 1)
      : (at + delta + stops.length) % stops.length
    stops[next]?.focus()
  }

  static handle(
    event: React.KeyboardEvent,
    state: LauncherState,
    manage: ManageState,
    screen: LauncherScreen,
    ports: LauncherPorts,
    card: HTMLElement | null,
  ): void {
    // Tab is never left to the browser: at the edge it would take focus out of an overlay the user
    // cannot see they have left. Which of the three meanings it has belongs to the screen.
    if (event.key === 'Tab') {
      event.preventDefault()
      if (event.ctrlKey || event.altKey || event.metaKey || LauncherKeys.typing(event.target))
        return
      return LauncherKeys.tab(LauncherScreens.tabOf(screen), event, state, ports, card)
    }
    if (event.ctrlKey || event.altKey || event.metaKey)
      return
    // Escape and Enter belong to the surface wherever focus sits: they end an edit rather than type
    // into it, and which edit that is depends on how many layers are open.
    if (event.key === 'Escape') {
      event.preventDefault()
      if (screen.kind === 'projects' && state.search.active && event.target instanceof HTMLInputElement) {
        event.target.blur()
        card?.focus()
      }
      return LauncherScreens.escape(screen, ports, manage)
    }
    if (event.key === 'Enter') {
      // The one place Enter is not the surface's: a flow's multi-line fields are where a newline is
      // typed, and a screen that submits instead is a screen nobody can write a paragraph in.
      if (screen.kind === 'flow' && event.target instanceof HTMLTextAreaElement)
        return
      event.preventDefault()
      return LauncherScreens.enter(screen, ports, manage)
    }
    // Down is the way out of a field the caret is in: out of the filter back into the list, and out
    // of the create screen's name row into the row under it. Without it a field is somewhere the
    // keyboard can get into and not out of, which is what both of them would be - the filter is
    // opened by Up from the first row, and the create card OPENS on its name.
    //
    // Which field this is comes from the model - `search.active` IS "the filter field holds the
    // caret", and the create screen's `field` says the same thing about its name row - and never
    // from a class name on the element: a styling rename nothing gates would otherwise take the
    // only keyboard way out of the field with it.
    if (LauncherKeys.typing(event.target)) {
      if (screen.kind === 'projects' && state.search.active && state.search.text.length === 0
        && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        event.preventDefault()
        const input = LauncherKeys.categoryStep(state, event.key === 'ArrowLeft' ? -1 : 1)
        if (input)
          ports.dispatch(input)
        return
      }
      if (event.key !== 'ArrowDown' || !(event.target instanceof HTMLElement))
        return
      const leavingName = screen.kind === 'create' && screen.state.field === 'name'
      if (!state.search.active && !leavingName)
        return
      event.preventDefault()
      event.target.blur()
      if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus()
      // The caret and the cursor row are the same fact, so the row moves with the caret rather
      // than being left on a field nothing is typing into.
      if (leavingName) ports.create({ input: 'moveField', delta: 1 })
      return
    }
    /*
     * Every screen answers for its own letters. A screen left as the implicit remainder does not go
     * quiet, it inherits the projects screen's keys: `F2` then `a` twice archives a project the
     * screen is not showing. The catalog is what makes "its own" a thing the compiler counts.
     */
    LauncherScreens.press(event, screen, ports, { state, manage, card })
  }

  /** The four things Tab can mean, and the throw for a fifth nobody has decided. */
  private static tab(
    behaviour: LauncherScreenTab,
    event: React.KeyboardEvent,
    state: LauncherState,
    ports: LauncherPorts,
    card: HTMLElement | null,
  ): void {
    if (behaviour === 'agent')
      ports.create({ input: 'cycleAgent' })
    else if (behaviour === 'focus')
      LauncherKeys.stepFocus(card, event.shiftKey ? -1 : 1)
    else if (behaviour === 'category') {
      const step = LauncherKeys.categoryStep(state, event.shiftKey ? -1 : 1)
      if (step)
        ports.dispatch(step)
    } else
      throw new Error(`Unknown launcher Tab behaviour: ${JSON.stringify(behaviour)}`)
  }

  static projectsKey(
    event: React.KeyboardEvent,
    state: LauncherState,
    manage: ManageState,
    ports: LauncherPorts,
  ): void {
    // Making a project belongs to the CATEGORY, so it answers wherever the cursor stands - including
    // on a folder row and in a root holding nothing at all, which is the root somebody wants the
    // first project in. Not while the other strip is up: one strip at a time, and the key line under
    // it names that strip's keys rather than this one.
    if (event.key === 'F7' && manage.operation === null) {
      event.preventDefault()
      return ports.dispatch({ input: 'newProjectStart' })
    }
    const action = LauncherKeys.manageInputOf(event, state, manage)
    if (action) {
      event.preventDefault()
      return ports.manage(action)
    }
    const input = LauncherKeys.browseInputOf(event, state)
    if (!input)
      return
    event.preventDefault()
    ports.dispatch(input)
  }

  /** The computer list answers the two arrows and nothing else; Enter and Escape are taken above. */
  static computersInputOf(key: string): ComputersScreenInput | null {
    if (key === 'ArrowDown')
      return { input: 'moveCursor', delta: 1 }
    if (key === 'ArrowUp')
      return { input: 'moveCursor', delta: -1 }
    return null
  }

  /**
   * The second screen's own keys. Every one of them is a button in the options bar as well, and a
   * letter reaches this only while the filter field does NOT hold focus - inside it, a w is a w.
   */
  static createInputOf(key: string): CreateScreenInput | null {
    if (key === 'ArrowDown')
      return { input: 'moveField', delta: 1 }
    if (key === 'ArrowUp')
      return { input: 'moveField', delta: -1 }
    if (key === 'ArrowLeft')
      return { input: 'stepChoice', delta: -1 }
    if (key === 'ArrowRight')
      return { input: 'stepChoice', delta: 1 }
    // The letters the footer names. They survive the card layout on purpose: arrows are how a form
    // is walked, and a shortcut is how somebody who knows it skips the walk.
    const letter = key.toLowerCase()
    if (letter === 'w')
      return { input: 'toggleWorktree' }
    if (letter === 'n')
      return { input: 'nameFocus' }
    return null
  }

  /**
   * The four things that can be done to the project under the cursor, in two pairs, because each
   * pair is one thing with two ends. `F6` and `⇧F6` both relocate the directory - to a new name and
   * to a new folder - and the library runs them as one call. `F8` and `⇧F8` both get rid of it, the
   * unshifted one reversibly.
   *
   * They are function keys rather than letters, which is the whole reason the manage MODE is gone: a
   * letter that acts has to be gated or it stops being the first letter of a project to jump to, and
   * the gate was `F2`. Nothing gates these, so they answer straight from the list. There is still a
   * key that does nothing without a target - the cursor can stand on a folder - and there the line
   * names none of them.
   *
   * An open operation takes the line with it. The archive answers its own question, so `F8` stays
   * live while it is asking; the delete does not, because its confirmation carries a file count and
   * no key can carry a number somebody has read.
   */
  private static manageInputOf(
    event: React.KeyboardEvent,
    state: LauncherState,
    manage: ManageState,
  ): ManageInput | null {
    // A field holding the caret takes every key it can use, and both strips are a field.
    if (manage.target === null || state.newProject !== null || LauncherKeys.typing(event.target))
      return null
    if (manage.operation !== null)
      return manage.operation.op === 'archive' && event.key === 'F8'
        ? { input: 'archiveStart' }
        : null
    if (event.key === 'F6')
      return event.shiftKey ? { input: 'movePrefixStart' } : { input: 'renameStart' }
    if (event.key === 'F8')
      return event.shiftKey ? { input: 'deleteStart' } : { input: 'archiveStart' }
    return null
  }

  private static browseInputOf(
    event: React.KeyboardEvent,
    state: LauncherState,
  ): LauncherInput | null {
    const key = event.key
    if (key === 'ArrowDown')
      return { input: 'moveCursor', delta: 1 }
    if (key === 'ArrowUp')
      return { input: 'moveCursor', delta: -1 }
    if (key === 'ArrowLeft')
      return LauncherKeys.categoryStep(state, -1)
    if (key === 'ArrowRight')
      return LauncherKeys.categoryStep(state, 1)
    if (key === 'Backspace')
      return { input: 'backspace' }
    if (key === 'F1')
      return { input: 'searchOpen' }
    if (key === 'F3')
      return { input: 'toggleView' }
    if (key === 'F4')
      return { input: 'cycleSort' }
    if (key >= '1' && key <= '9')
      return LauncherKeys.categoryAt(state, Number(key) - 1)
    if (key.length === 1)
      return { input: 'typed', character: key }
    return null
  }

  private static categoryStep(state: LauncherState, step: number): LauncherInput | null {
    const at = state.categories.findIndex((category) => category.id === state.activeCategoryId)
    if (at < 0)
      return null
    return LauncherKeys.categoryAt(state, at + step)
  }

  private static categoryAt(state: LauncherState, index: number): LauncherInput | null {
    const category = state.categories[index]
    if (!category)
      return null
    return { input: 'selectCategory', categoryId: category.id }
  }

  private static typing(target: EventTarget): boolean {
    return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
  }
}
