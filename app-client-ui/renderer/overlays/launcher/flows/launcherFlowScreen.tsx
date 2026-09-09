import type { SessionSetupAgreement } from '../../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { CreateScreenModel } from '../create/createScreenModel'
import { LauncherLabels } from '../launcherLabels'
import { FlowCatalog } from './flowCatalog'
import './flows.css'
import type { FlowScreenInput, FlowScreenState } from './flowScreenModel'

/**
 * The frame a flow's form is drawn in.
 *
 * It says where the session will run and what the create screen already chose, draws the flow's own
 * fields, and carries the one button that starts it. Everything specific to a flow comes from the
 * catalog, so a second flow is a directory and one entry rather than a change here.
 */
export function LauncherFlowScreen(props: {
  state: FlowScreenState
  dispatch(input: FlowScreenInput): void
}): React.JSX.Element {
  const { state, dispatch } = props
  const flow = FlowCatalog.byId(state.flowId)
  // No cast: `SessionFlowSpec` defaults both its parameters to `unknown`, so `flow.Form` already
  // has exactly this shape. The cast that stood here re-stated it, and would have kept compiling if
  // the prop shape moved underneath - which is the one moment a cast should have failed.
  const Form = flow.Form

  return (
    <div className="jamat-launcher-flows">
      <div className="jamat-launcher-flows__row">
        <span className="jamat-launcher-flows__label">Project</span>
        <span className="jamat-launcher-flows__path">
          {LauncherLabels.whereOf(state.options.binding)}
        </span>
      </div>
      <div className="jamat-launcher-flows__row">
        <span className="jamat-launcher-flows__label">Session</span>
        <span className="jamat-launcher-flows__carried">{FlowScreenText.carriedOf(state)}</span>
      </div>

      <Form
        state={state.form}
        problem={state.problem}
        dispatch={(value: unknown) => dispatch({ input: 'formInput', value })}
      />

      <div className="jamat-launcher-flows__start">
        <button
          className="jamat-launcher__start-button"
          type="button"
          disabled={state.submitting}
          onClick={() => dispatch({ input: 'activate' })}
        >
          Start session
          <span className="jamat-launcher__key"> Enter</span>
        </button>
      </div>

      <p className="jamat-launcher-flows__note">
        Runs as its own session. You can watch it or leave it, it keeps going either way.
      </p>

      {state.submitError !== null && (
        <p className="jamat-launcher__error">
          <span className="jamat-launcher__code">{state.submitError.code}</span>
          {` ${state.submitError.detail}`}
        </p>
      )}
      {state.submitError?.setup !== undefined && (
        <SetupAgreement setup={state.submitError.setup} dispatch={dispatch} />
      )}
      {state.submitting && <p className="jamat-launcher__note">Starting…</p>}
    </div>
  )
}

/** The same block the create screen draws, for the same reason and with the same refusal to key it. */
function SetupAgreement(props: {
  setup: SessionSetupAgreement
  dispatch(input: FlowScreenInput): void
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

class FlowScreenText {
  /** What was already decided one screen back, read-only here so it is visible but not re-asked. */
  static carriedOf(state: FlowScreenState): string {
    const options = state.options
    const title = CreateScreenModel.titleOf(options, options.token)
    const parts = [
      title ?? 'unnamed',
      LauncherLabels.agentLabelOf(options.agentId),
      FlowScreenText.isolationOf(state),
    ]
    return parts.join(' · ')
  }

  private static isolationOf(state: FlowScreenState): string {
    const options = state.options
    const suggested = FlowScreenText.suggestsWorktree(state)
    if (!options.worktree && !suggested) return 'no worktree'
    const preview = CreateScreenModel.worktreePreviewOf(
      { ...options, worktree: true },
      options.token,
    )
    if (preview === null) return 'no worktree'
    return `Worktree ${preview.branch}`
  }

  private static suggestsWorktree(state: FlowScreenState): boolean {
    const composed = FlowCatalog.byId(state.flowId).composeOf(state.form)
    return 'problem' in composed ? false : composed.worktreeSuggested
  }
}
