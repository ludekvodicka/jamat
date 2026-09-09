import type { SessionSetupAgreement } from '../../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { useEffect, useRef } from 'react'

import { FlowCatalog } from '../flows/flowCatalog'
import { AgentGlyph } from '../../../sessions/agentGlyph'
import { ChoiceCard, ChoiceRow } from '../../../widgets/choiceCards'
import { LauncherLabels } from '../launcherLabels'
import './create.css'
import type {
  CreateScreenInput,
  CreateScreenState,
  CreateType,
} from './createScreenModel'
import { CreateScreenModel } from './createScreenModel'
import { ExistingSessions } from './existingSessions'

/**
 * The second screen: what starts, and how.
 *
 * A two-column form of choice cards. Every card is a button and every row also has its letter, and
 * both go through the same input, so a card and a key can never mean different things. What an
 * option refuses to do it says out loud beside itself instead of going quiet.
 */
export function LauncherCreateScreen(props: {
  state: CreateScreenState
  dispatch(input: CreateScreenInput): void
}): React.JSX.Element {
  const { state, dispatch } = props
  const nameInput = useRef<HTMLInputElement | null>(null)
  /*
   * `N` marked the row and left the caret where it was, so the letters that followed went to the
   * key handler instead of into the field: `w` toggled the worktree, `n` marked the row again,
   * and the rest were dropped - while the footer advertised the key as "Name". The projects search
   * moves focus for the same reason.
   */
  useEffect(() => {
    if (state.field !== 'name') return
    const input = nameInput.current
    if (input === null || document.activeElement === input) return
    input.focus()
  }, [state.field])
  const preview = CreateScreenModel.worktreePreviewOf(state, state.token)
  const worktreeRefusal = CreateScreenModel.worktreeRefusal(state)
  const agentRefusal = CreateScreenModel.agentRefusal(state)
  const existing = CreateScreenModel.typeOf(state).kind === 'existing'
  const existingRefusal = existing ? CreateScreenModel.existingRefusal(state) : null
  const remote = CreateScreenModel.endpointOf(state.target) !== null
  const remoteRefusals = CreateScreenModel.remoteRefusals(state)
  const modelOptions = CreateScreenModel.modelOptionsOf(state)
  const modelRefusal = CreateScreenModel.modelRefusal(state)
  const modelNote = CreateScreenModel.modelNoteOf(state)

  return (
    <div className="jamat-launcher-create">
      <ChoiceRow label="Project" current={false}>
        <span className="jamat-launcher-create__path">
          {LauncherLabels.whereOf(state.binding)}
        </span>
      </ChoiceRow>

      {!existing && (
      <ChoiceRow label="Name" current={state.field === 'name'}>
        {/* The number is not editable, so it is drawn beside the field rather than typed into it:
            putting it in the value would make backspace able to delete the thing that names the
            branch. */}
        <span className="jamat-launcher-create__name">
          {state.token !== null && (
            <span className="jamat-launcher-create__token">{`${state.token} - `}</span>
          )}
          <input
            ref={nameInput}
            className="jamat-launcher-create__name-input"
            type="text"
            aria-label="Session name"
            placeholder={state.token === null ? 'name this session' : 'type to append a name'}
            value={state.name}
            onFocus={() => dispatch({ input: 'nameFocus' })}
            onChange={(event) => dispatch({ input: 'nameChanged', name: event.target.value })}
          />
        </span>
      </ChoiceRow>
      )}

      <ChoiceRow label="Type" current={state.field === 'type'}>
        <div className="jamat-choice__cards">
          {CreateScreenModel.typesOf(state).map((type, index) => (
            <ChoiceCard
              key={CreateTypes.keyOf(type)}
              title={CreateTypes.titleOf(type, state.tabProfile, remote)}
              note={CreateTypes.noteOf(type, state.tabProfile, remote)}
              glyph={CreateTypes.glyphOf(type)}
              chosen={index === state.typeIndex}
              refusal={CreateScreenModel.typeRefusal(state, type)}
              onChoose={() => dispatch({ input: 'chooseType', index })}
            />
          ))}
        </div>
      </ChoiceRow>

      {/* A tab has no isolation by definition and a worktree on another computer is set up there,
          so the row that would ask is not drawn at all rather than drawn and refused. Both cards
          say what they left out - the tab card in its own words below, the remote card in the list
          under the form. */}
      {!state.tabProfile && !remote && !existing && (
      <ChoiceRow label="Isolation" current={state.field === 'isolation'}>
        <div className="jamat-choice__cards">
          <ChoiceCard
            title="None"
            note="runs in the project directory"
            glyph="—"
            chosen={!state.worktree}
            refusal={null}
            onChoose={() => dispatch({ input: 'chooseIsolation', worktree: false })}
          />
          <ChoiceCard
            title="Worktree"
            note="runs in its own worktree and branch"
            glyph="◆"
            chosen={state.worktree}
            refusal={worktreeRefusal}
            onChoose={() => dispatch({ input: 'chooseIsolation', worktree: true })}
          />
        </div>
        {state.worktree && preview !== null && (
          <p className="jamat-launcher-create__note">
            {'Branch '}
            <code>{preview.branch}</code>
            {', runs in '}
            <code>{preview.path}</code>
            {', from HEAD'}
          </p>
        )}
        {!state.worktree && worktreeRefusal !== null && (
          <p className="jamat-launcher-create__refusal">{worktreeRefusal}</p>
        )}
      </ChoiceRow>
      )}

      <ChoiceRow label="Agent" current={state.field === 'agent'}>
        <div className="jamat-choice__cards">
          {(existing ? ['claude', 'codex', 'all'] as const : ['claude', 'codex'] as const)
            .map((agentId) => (
            <ChoiceCard
              key={agentId}
              title={agentId === 'all' ? 'All' : LauncherLabels.agentLabelOf(agentId)}
              note={null}
              glyph={agentId === 'all' ? '∗' : AgentGlyph.markOf(agentId)}
              glyphClass={agentId === 'all'
                ? 'jamat-choice__glyph'
                : `jamat-launcher__agent jamat-launcher__agent--${agentId}`}
              chosen={existing
                ? state.existingAgentFilter === agentId
                : state.agentId === agentId}
              refusal={agentRefusal}
              onChoose={() => agentId === 'all'
                ? dispatch({ input: 'chooseExistingAgent', agentId })
                : dispatch(existing
                    ? { input: 'chooseExistingAgent', agentId }
                    : { input: 'chooseAgent', agentId })}
            />
            ))}
        </div>
        {agentRefusal !== null && (
          <p className="jamat-launcher-create__refusal">{agentRefusal}</p>
        )}
      </ChoiceRow>

      {/* Remote only: what a session started HERE runs on is this computer's own setting, and the
          row that would ask is the settings tab. On a remote card the offer is the target's, so it
          is asked for - and where that computer cannot answer, the row says so rather than going
          quiet, because a picker that is not drawn reads as one that was forgotten. */}
      {remote && !existing && (
      <ChoiceRow label="Model" current={state.field === 'model'}>
        {modelOptions.length > 0 && (
          <select
            className="jamat-launcher-create__model"
            aria-label="Model on the target computer"
            value={state.modelId ?? ''}
            onChange={(event) => dispatch({
              input: 'chooseModel',
              modelId: event.currentTarget.value === '' ? null : event.currentTarget.value,
            })}
          >
            {/* The prefix keeps the default line's key distinct from every id, including an
                empty one: these came off another computer and nothing here decides them. */}
            {modelOptions.map((option) => (
              <option
                key={option.id === null ? 'target-default' : `id:${option.id}`}
                value={option.id ?? ''}
              >
                {option.label}
              </option>
            ))}
          </select>
        )}
        {modelNote !== null && (
          <p className="jamat-launcher-create__note">{modelNote}</p>
        )}
        {modelRefusal !== null && (
          <p className="jamat-launcher-create__refusal">{modelRefusal}</p>
        )}
        {CreateScreenModel.modelRetryable(state) && (
          <button
            className="jamat-launcher-create__model-retry"
            type="button"
            onClick={() => dispatch({ input: 'retryDescribe' })}
          >
            Ask again
          </button>
        )}
      </ChoiceRow>
      )}

      {existing && (
        <ChoiceRow
          className="jamat-launcher-create__sessions-field"
          label="Existing sessions"
          current={state.field === 'existingSessions'}
        >
          <ExistingSessions state={state} now={Date.now()} dispatch={dispatch} />
        </ChoiceRow>
      )}

      <div className="jamat-launcher__start">
        <button
          className="jamat-launcher__start-button"
          type="button"
          disabled={state.submitting || state.targetLost || existingRefusal !== null}
          title={existingRefusal ?? undefined}
          onClick={() => dispatch({ input: 'activate' })}
        >
          {CreateTypes.submitLabelOf(CreateScreenModel.typeOf(state))}
          <span className="jamat-launcher__key"> Enter</span>
        </button>
      </div>

      {state.targetLost && (
        <p className="jamat-launcher__error">
          {`${CreateScreenModel.targetNameOf(state.target)} is no longer connected. `
            + 'Nothing can start on it until it is back.'}
        </p>
      )}
      {state.submitError !== null && (
        <p className="jamat-launcher__error">
          <span className="jamat-launcher__code">{state.submitError.code}</span>
          {` ${state.submitError.detail}`}
        </p>
      )}
      {/* The one refusal a remote create can answer with a second press of the same key: the answer
          never arrived, so the request is repeated with the id it already used and the far side
          answers with what it decided the first time. */}
      {state.pendingCreate !== null && (
        <p className="jamat-launcher__note">
          {'Nothing was lost and nothing was doubled: Enter sends the same request again, '}
          {'and that computer answers with what it decided the first time.'}
        </p>
      )}
      {state.submitError?.setup !== undefined && (
        <SetupAgreement setup={state.submitError.setup} dispatch={dispatch} />
      )}
      {state.submitting && (
        <p className="jamat-launcher__note">{existing ? 'Opening…' : 'Starting…'}</p>
      )}
      {remoteRefusals.length > 0 && (
        <ul className="jamat-launcher-create__refusals">
          {remoteRefusals.map((sentence) => (
            <li key={sentence} className="jamat-launcher-create__refusal">{sentence}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * The one refusal a person can answer from this screen. The commands are drawn verbatim and in the
 * order they run, because agreeing to a summary of somebody else's shell is not agreeing to anything:
 * this text is what the repository's `.worktree.json` asks to run in a fresh worktree.
 *
 * There is no key for it. Every other option here is reachable from the keyboard, and this one is
 * deliberately not - a keystroke that runs a foreign command is exactly what a habit turns into an
 * accident.
 */
function SetupAgreement(props: {
  setup: SessionSetupAgreement
  dispatch(input: CreateScreenInput): void
}): React.JSX.Element {
  const { setup, dispatch } = props
  return (
    <div className="jamat-launcher__agreement">
      <p className="jamat-launcher__note">
        This project asks to run its own commands in the new worktree:
      </p>
      <ol className="jamat-launcher__commands">
        {setup.commands.map((command, index) => (
          <li key={`${index}:${command}`}><code>{command}</code></li>
        ))}
      </ol>
      <button
        className="jamat-launcher__acknowledge"
        type="button"
        onClick={() => dispatch({ input: 'acknowledgeSetup' })}
      >
        I understand, run them
      </button>
    </div>
  )
}

/** What each type card says. A flow's words are the flow's own, read from the catalog. */
class CreateTypes {
  static keyOf(type: CreateType): string {
    if (type.kind === 'raw') return 'raw'
    else if (type.kind === 'shell') return 'shell'
    else if (type.kind === 'flow') return `flow:${type.flowId}`
    else if (type.kind === 'existing') return 'existing'
    else
      throw new Error(`Unknown create type: ${JSON.stringify(type)}`)
  }

  /**
   * `Raw` is the session card's word for it; the tab card, which asks less, calls it `New`.
   * `Continue/Fork` becomes `Continue` on a remote card, because a fork is not what the target does
   * with a reopen and a label that promised one would be promising the target's behaviour.
   */
  static titleOf(type: CreateType, tabProfile: boolean, remote: boolean): string {
    if (type.kind === 'raw') return tabProfile ? 'New' : 'Raw'
    else if (type.kind === 'shell') return 'Shell'
    else if (type.kind === 'flow') return FlowCatalog.byId(type.flowId).title
    else if (type.kind === 'existing') return remote ? 'Continue' : 'Continue/Fork'
    else
      throw new Error(`Unknown create type: ${JSON.stringify(type)}`)
  }

  /**
   * Continue/Fork says what it lands in when the card around it is called `New tab`: a fork can never
   * be reopened by id, so the library refuses to hold one in a tab, and the card has to say that
   * rather than let the title promise a tab the result will not be.
   */
  static noteOf(type: CreateType, tabProfile: boolean, remote: boolean): string {
    if (type.kind === 'raw') return 'start the agent, type in the terminal'
    else if (type.kind === 'shell') return 'a plain terminal, no agent'
    else if (type.kind === 'flow') return FlowCatalog.byId(type.flowId).description
    else if (type.kind === 'existing')
      return remote
        ? 'reopen a session that computer already keeps'
        : tabProfile
          ? 'resume or fork, opens as a kept session'
          : 'resume ended sessions, fork running ones'
    else
      throw new Error(`Unknown create type: ${JSON.stringify(type)}`)
  }

  static glyphOf(type: CreateType): string {
    if (type.kind === 'raw') return '❯_'
    else if (type.kind === 'shell') return '$'
    else if (type.kind === 'flow') return '≡'
    else if (type.kind === 'existing') return '↳'
    else
      throw new Error(`Unknown create type: ${JSON.stringify(type)}`)
  }

  static submitLabelOf(type: CreateType): string {
    if (type.kind === 'flow') return 'Configure'
    else if (type.kind === 'existing') return 'Continue/Fork'
    else if (type.kind === 'raw' || type.kind === 'shell') return 'Start'
    else
      throw new Error(`Unknown create type: ${JSON.stringify(type)}`)
  }
}
