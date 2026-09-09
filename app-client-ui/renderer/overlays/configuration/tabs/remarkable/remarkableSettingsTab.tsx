import { useEffect, useId, useRef, useState } from 'react'

import type {
  RemarkableDependencyStatus,
  RemarkableErrorCode,
} from '../../../../../shared/remarkableApi.types'
import { RemarkableSettings } from '../../../../../shared/remarkableSettings'
import { ConfigurationSection } from '../../configurationSection'
import type { ConfigurationTabProps } from '../../configurationTab.types'
import './remarkableSettings.css'
import {
  RemarkableSettingsEffects,
  type RemarkableSettingsPorts,
} from './remarkableSettingsEffects'
import {
  RemarkableSettingsModel,
  type RemarkableSettingsFailureCode,
  type RemarkableSettingsMachineAction,
  type RemarkableSettingsModelState,
  type RemarkableSetupBlocker,
  type RemarkableSetupStep,
  type RemarkableSetupStepId,
} from './remarkableSettingsModel'

/**
 * The single line under a row title. A step has one thing to say at a time: what it is doing, what
 * it is waiting for, or how it ended. Three stacked lines is what made this card tall.
 */
interface RemarkableRowNote {
  text: string
  tone: 'hint' | 'attention' | 'ok' | 'bad'
}

export function RemarkableSettingsTab(props: ConfigurationTabProps): React.JSX.Element {
  const [start] = useState(() => RemarkableSettingsModel.initial())
  const [state, setState] = useState<RemarkableSettingsModelState>(start.state)
  const stateRef = useRef(start.state)
  const reportedDirty = useRef(false)
  const dirtyChange = useRef(props.onDirtyChange)
  const mounted = useRef(true)
  dirtyChange.current = props.onDirtyChange
  const hostId = useId()
  const fingerprintId = useId()
  const timeoutId = useId()
  const passwordId = useId()

  const [ports] = useState<RemarkableSettingsPorts>(() => {
    const self: RemarkableSettingsPorts = {
      dispatch: (input) => {
        if (!mounted.current) return
        const step = RemarkableSettingsModel.transition(stateRef.current, input)
        stateRef.current = step.state
        setState(step.state)
        const modified = RemarkableSettingsModel.isModified(step.state)
        if (modified !== reportedDirty.current) {
          reportedDirty.current = modified
          dirtyChange.current(modified)
        }
        for (const effect of step.effects)
          void RemarkableSettingsEffects.run(effect, self)
      },
    }
    return self
  })

  useEffect(() => {
    for (const effect of start.effects)
      void RemarkableSettingsEffects.run(effect, ports)
  }, [ports, start.effects])

  useEffect(() => () => {
    mounted.current = false
  }, [])

  const buffer = state.persisted.buffer
  const dirty = RemarkableSettingsModel.isModified(state)
  const saving = state.persisted.saving !== null
  const busy = state.running !== null
  const passwordConfigured = RemarkableSettingsModel.passwordConfigured(state)
  const controlsDisabled = buffer === null || saving || busy
  const steps = new Map<RemarkableSetupStepId, RemarkableSetupStep>(
    RemarkableSettingsModel.setupSteps(state).map((setupStep) => [setupStep.id, setupStep]),
  )
  const step = (id: RemarkableSetupStepId): RemarkableSetupStep => {
    const found = steps.get(id)
    if (found === undefined) throw new Error(`Missing reMarkable setup step: ${id}`)
    return found
  }
  const passwordStep = step('password')
  const fingerprintStep = step('fingerprint')
  const connectionStep = step('connection')
  const dependency = RemarkableSettingsDependencyView.render(
    state.dependencies,
    state.running,
    () => ports.dispatch({ input: 'install-dependencies' }),
  )

  return (
    <div className="jamat-configuration-remarkable">
      {state.persisted.problem !== null && (
        <p className="jamat-configuration__problem" role="alert">
          {state.persisted.problem}
        </p>
      )}
      {state.actionProblem !== null && (
        <p className="jamat-configuration__problem" role="alert">
          {RemarkableSettingsViewText.failure(state.actionProblem.code)}{' '}
          {state.actionProblem.detail}
        </p>
      )}
      {buffer === null && (
        <p className="jamat-configuration-remarkable__loading">Reading config.json…</p>
      )}

      <ConfigurationSection title="This machine">
        <RemarkableSettingsRow
          title="Dependencies"
          note={dependency.note}
          step={step('dependencies')}
        >{dependency.action}</RemarkableSettingsRow>
      </ConfigurationSection>

      <ConfigurationSection title="Tablet">
        <RemarkableSettingsRow
          title="Tablet host or IP address"
          note={RemarkableSettingsNote.host(dirty)}
          step={step('host')}
          htmlFor={hostId}
        >
          <input
            id={hostId}
            className="jamat-configuration-remarkable__input"
            type="text"
            autoComplete="off"
            spellCheck={false}
            disabled={controlsDisabled}
            value={buffer?.host ?? ''}
            onChange={(event) => ports.dispatch({
              input: 'host',
              value: event.currentTarget.value,
            })}
          />
        </RemarkableSettingsRow>

        <RemarkableSettingsRow
          title="Connection timeout"
          note={{ text: 'Milliseconds allowed for one tablet command.', tone: 'hint' }}
          htmlFor={timeoutId}
        >
          <input
            id={timeoutId}
            className="jamat-configuration-remarkable__timeout"
            type="number"
            min={RemarkableSettings.timeoutMillisecondsMinConst}
            max={RemarkableSettings.timeoutMillisecondsMaxConst}
            step={1}
            disabled={controlsDisabled}
            value={buffer?.timeoutMilliseconds
              ?? RemarkableSettings.timeoutMillisecondsDefaultConst}
            onChange={(event) => ports.dispatch({
              input: 'timeout',
              value: Number(event.currentTarget.value),
            })}
          />
        </RemarkableSettingsRow>
      </ConfigurationSection>

      <ConfigurationSection title="Trust">
        <RemarkableSettingsRow
          title="Tablet password"
          note={RemarkableSettingsNote.password(state, passwordStep)}
          step={passwordStep}
          htmlFor={passwordId}
        >
          <input
            id={passwordId}
            className="jamat-configuration-remarkable__input"
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            disabled={buffer === null || busy || saving}
            value={state.passwordDraft}
            onChange={(event) => ports.dispatch({
              input: 'password-draft',
              value: event.currentTarget.value,
            })}
          />
          <button
            className="jamat-configuration__button jamat-configuration__button--primary"
            type="button"
            disabled={passwordStep.blockedBy !== null
              || state.passwordDraft.length === 0
              || busy
              || saving}
            onClick={() => ports.dispatch({ input: 'set-password' })}
          >Set or replace password</button>
          <button
            className="jamat-configuration__button"
            type="button"
            disabled={!passwordConfigured || busy}
            onClick={() => ports.dispatch({ input: 'clear-password' })}
          >Clear password</button>
        </RemarkableSettingsRow>

        <RemarkableSettingsRow
          title="Pinned SSH fingerprint"
          note={RemarkableSettingsNote.fingerprint(state, fingerprintStep)}
          step={fingerprintStep}
          htmlFor={fingerprintId}
        >
          <input
            id={fingerprintId}
            className="jamat-configuration-remarkable__input jamat-configuration-remarkable__fingerprint"
            type="text"
            readOnly
            value={buffer?.fingerprint ?? ''}
          />
          <button
            className="jamat-configuration__button"
            type="button"
            disabled={fingerprintStep.blockedBy !== null || busy || saving}
            onClick={() => ports.dispatch({ input: 'detect-fingerprint' })}
          >Detect fingerprint</button>
        </RemarkableSettingsRow>

        {state.fingerprintCandidate !== null && (
          <div className="jamat-configuration-remarkable__candidate" role="status">
            <code>{state.fingerprintCandidate.fingerprint}</code>
            <span>
              Detected for {state.fingerprintCandidate.host}. Verify it through a trusted path first.
            </span>
            <button
              className="jamat-configuration__button jamat-configuration__button--primary"
              type="button"
              disabled={busy || saving || buffer?.host !== state.fingerprintCandidate.host}
              onClick={() => ports.dispatch({ input: 'confirm-fingerprint' })}
            >Use and save this fingerprint</button>
          </div>
        )}
      </ConfigurationSection>

      <ConfigurationSection title="Check">
        <RemarkableSettingsRow
          title="Connection"
          note={RemarkableSettingsNote.connection(state, connectionStep)}
          step={connectionStep}
        >
          <button
            className="jamat-configuration__button"
            type="button"
            disabled={connectionStep.blockedBy !== null || busy || saving}
            onClick={() => ports.dispatch({ input: 'test-connection' })}
          >Test connection</button>
        </RemarkableSettingsRow>

        <p className="jamat-configuration-remarkable__footnote">
          Dependencies, the password and a used fingerprint are written the moment you press their
          button. Save and Reset below carry the host and the timeout only.
        </p>
      </ConfigurationSection>

      <div className="jamat-configuration__actions">
        <button
          className="jamat-configuration__button"
          type="button"
          disabled={buffer === null || saving || busy}
          onClick={() => ports.dispatch({ input: 'reset' })}
        >Reset to defaults</button>
        <button
          className="jamat-configuration__button jamat-configuration__button--primary"
          type="button"
          disabled={!dirty || saving || busy}
          onClick={() => ports.dispatch({ input: 'save' })}
        >{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  )
}

/**
 * Title, one note line, controls on the right: the shape the other configuration tabs already use.
 * A numbered step also carries its own state, so the whole setup is readable without leaving the
 * card.
 */
function RemarkableSettingsRow(props: {
  title: string
  note: RemarkableRowNote
  step?: RemarkableSetupStep
  htmlFor?: string
  children?: React.ReactNode
}): React.JSX.Element {
  const step = props.step
  return (
    <div className="jamat-configuration-remarkable__row">
      <div className="jamat-configuration-remarkable__heading">
        <span className="jamat-configuration-remarkable__title">
          {step !== undefined && (
            <span className="jamat-configuration-remarkable__number" aria-hidden="true">
              {step.position}
            </span>
          )}
          {props.htmlFor === undefined
            ? <span>{props.title}</span>
            : <label htmlFor={props.htmlFor}>{props.title}</label>}
        </span>
        <span
          className={`jamat-configuration-remarkable__note jamat-configuration-remarkable__note--${props.note.tone}`}
          role={props.note.tone === 'bad' ? 'alert' : 'status'}
        >{props.note.text}</span>
      </div>
      <div className="jamat-configuration-remarkable__control">{props.children}</div>
      {step === undefined
        ? <span className="jamat-configuration-remarkable__status" aria-hidden="true" />
        : (
          <span
            className={`jamat-configuration-remarkable__status jamat-configuration-remarkable__status--${step.done ? 'done' : 'todo'}`}
            role="img"
            aria-label={RemarkableStepText.status(step)}
            title={RemarkableStepText.status(step)}
          >{step.done ? '✓' : '!'}</span>
        )}
    </div>
  )
}

/** One row says one thing: running beats blocked, blocked beats the result of an older run. */
class RemarkableSettingsNote {
  static host(dirty: boolean): RemarkableRowNote {
    if (dirty)
      return { text: 'Unsaved changes. Press Save below to continue.', tone: 'attention' }
    return {
      text: 'The password and the fingerprint are stored against the SAVED host.',
      tone: 'hint',
    }
  }

  static password(
    state: RemarkableSettingsModelState,
    step: RemarkableSetupStep,
  ): RemarkableRowNote {
    if (state.running === 'set-password' || state.running === 'clear-password')
      return { text: RemarkableSettingsViewText.progress(state.running), tone: 'attention' }
    if (step.blockedBy !== null)
      return { text: RemarkableStepText.blocker(step.blockedBy), tone: 'attention' }
    if (RemarkableSettingsModel.passwordConfigured(state))
      return {
        text: `Configured for ${String(RemarkableSettingsModel.storedHost(state))}.`
          + ' Write-only: never in config.json.',
        tone: 'hint',
      }
    return { text: 'Write-only: it never appears in config.json.', tone: 'hint' }
  }

  static fingerprint(
    state: RemarkableSettingsModelState,
    step: RemarkableSetupStep,
  ): RemarkableRowNote {
    if (state.running === 'detect-fingerprint')
      return { text: RemarkableSettingsViewText.progress(state.running), tone: 'attention' }
    if (step.blockedBy !== null)
      return { text: RemarkableStepText.blocker(step.blockedBy), tone: 'attention' }
    return {
      text: 'Detection only proposes a value; using it pins and saves it.',
      tone: 'hint',
    }
  }

  static connection(
    state: RemarkableSettingsModelState,
    step: RemarkableSetupStep,
  ): RemarkableRowNote {
    if (state.running === 'test-connection')
      return { text: RemarkableSettingsViewText.progress(state.running), tone: 'attention' }
    if (step.blockedBy !== null)
      return { text: RemarkableStepText.blocker(step.blockedBy), tone: 'attention' }
    const test = state.connectionTest
    if (test === null)
      return { text: 'Runs one real command against the saved host.', tone: 'hint' }
    if (test.ok) return { text: 'The saved connection works.', tone: 'ok' }
    return {
      text: `${RemarkableSettingsViewText.failure(test.code)} ${test.detail}`,
      tone: 'bad',
    }
  }
}

class RemarkableStepText {
  /** What the mark on the right of the row says on hover: it is done, or what to do about it. */
  static status(step: RemarkableSetupStep): string {
    if (step.done) return RemarkableStepText.done(step.id)
    else if (step.blockedBy !== null) return RemarkableStepText.blocker(step.blockedBy)
    else return RemarkableStepText.todo(step.id)
  }

  private static done(id: RemarkableSetupStepId): string {
    if (id === 'dependencies') return 'Done: the verified sidecar bundle is installed.'
    else if (id === 'host') return 'Done: the tablet host is saved.'
    else if (id === 'password') return 'Done: a password is stored for the saved host.'
    else if (id === 'fingerprint') return 'Done: a fingerprint is pinned for the saved host.'
    else if (id === 'connection') return 'Done: the last connection test passed.'
    else {
      const unhandled: never = id
      throw new Error(`Unknown reMarkable setup step: ${JSON.stringify(unhandled)}`)
    }
  }

  private static todo(id: RemarkableSetupStepId): string {
    if (id === 'dependencies') return 'To do: press Install dependencies.'
    else if (id === 'host') return 'To do: enter the tablet host and press Save.'
    else if (id === 'password') return 'To do: type the password and press Set or replace password.'
    else if (id === 'fingerprint')
      return 'To do: press Detect fingerprint, then use the detected value.'
    else if (id === 'connection') return 'To do: press Test connection.'
    else {
      const unhandled: never = id
      throw new Error(`Unknown reMarkable setup step: ${JSON.stringify(unhandled)}`)
    }
  }

  static blocker(blocker: RemarkableSetupBlocker): string {
    if (blocker === 'dependencies-missing') return 'Install the dependencies in step 1 first.'
    else if (blocker === 'host-missing') return 'Enter a tablet host in step 2 and save it first.'
    else if (blocker === 'host-unsaved')
      return 'Press Save below first: this step is stored against the saved host.'
    else if (blocker === 'password-missing') return 'Set the tablet password in step 3 first.'
    else if (blocker === 'fingerprint-missing')
      return 'Detect and save a fingerprint in step 4 first.'
    else {
      const unhandled: never = blocker
      throw new Error(`Unknown reMarkable setup blocker: ${JSON.stringify(unhandled)}`)
    }
  }
}

class RemarkableSettingsDependencyView {
  static render(
    status: RemarkableDependencyStatus | null,
    running: RemarkableSettingsMachineAction | null,
    install: () => void,
  ): { note: RemarkableRowNote; action: React.JSX.Element | null } {
    if (status === null)
      return { note: { text: 'Checking dependencies…', tone: 'hint' }, action: null }
    // A ready bundle has nothing to repair, so its button forces the install again rather than
    // naming a step still to do. Sharing the repair label made a finished row read as unfinished.
    if (status.kind === 'ready')
      return RemarkableSettingsDependencyView.installable(
        `Ready. Node ${status.nodeVersion}, remarkable-cli ${status.cliVersion},`
          + ` bundle ${status.bundleId}.`,
        'hint',
        'Reinstall',
        'Reinstalling…',
        running,
        install,
      )
    else if (status.kind === 'missing')
      return RemarkableSettingsDependencyView.installable(
        status.detail,
        'attention',
        'Install dependencies',
        'Installing…',
        running,
        install,
      )
    else if (status.kind === 'outdated' || status.kind === 'damaged')
      return RemarkableSettingsDependencyView.installable(
        status.detail,
        'attention',
        'Repair dependencies',
        'Repairing…',
        running,
        install,
      )
    else if (status.kind === 'source-missing')
      return {
        note: { text: `Install source missing. ${status.detail}`, tone: 'bad' },
        action: null,
      }
    else if (status.kind === 'unsupported-platform')
      return {
        note: { text: `Unsupported platform. ${status.detail}`, tone: 'bad' },
        action: null,
      }
    // Two members carry three kinds each, so TypeScript cannot narrow the rest to never here.
    else throw new Error(`Unknown reMarkable dependency status: ${status.kind}`)
  }

  private static installable(
    detail: string,
    tone: RemarkableRowNote['tone'],
    label: string,
    busyLabel: string,
    running: RemarkableSettingsMachineAction | null,
    install: () => void,
  ): { note: RemarkableRowNote; action: React.JSX.Element } {
    const installing = running === 'install-dependencies'
    return {
      note: installing
        ? { text: RemarkableSettingsViewText.progress(running), tone: 'attention' }
        : { text: detail, tone },
      action: (
        <button
          className="jamat-configuration__button"
          type="button"
          disabled={running !== null}
          onClick={install}
        >{installing ? busyLabel : label}</button>
      ),
    }
  }
}

class RemarkableSettingsViewText {
  static progress(action: RemarkableSettingsMachineAction): string {
    if (action === 'install-dependencies') return 'Installing reMarkable dependencies…'
    else if (action === 'detect-fingerprint') return 'Detecting the tablet fingerprint…'
    else if (action === 'set-password') return 'Encrypting and storing the password…'
    else if (action === 'clear-password') return 'Clearing the stored password…'
    else if (action === 'test-connection') return 'Testing the saved connection…'
    else throw new Error(`Unknown reMarkable machine action: ${String(action)}`)
  }

  static failure(code: RemarkableSettingsFailureCode): string {
    if (code === 'transport') return 'The main process did not complete the request.'
    return RemarkableSettingsViewText.remarkableFailure(code)
  }

  private static remarkableFailure(code: RemarkableErrorCode): string {
    if (code === 'cancelled') return 'The operation was cancelled.'
    else if (code === 'credential-unavailable') return 'Secure password storage is unavailable.'
    else if (code === 'device-busy') return 'Another reMarkable operation is using the tablet.'
    else if (code === 'device-sleeping') return 'Wake the tablet and keep it awake.'
    else if (code === 'host-key-changed') return 'The saved fingerprint no longer matches the tablet.'
    else if (code === 'import-failed') return 'The page could not be written to the storage folder.'
    else if (code === 'install-failed') return 'The dependencies could not be installed.'
    else if (code === 'invalid-cli-output') return 'The reMarkable tool returned an invalid answer.'
    else if (code === 'invalid-operation') return 'The reMarkable operation is no longer valid.'
    else if (code === 'no-open-page') return 'The tablet does not say which page is open.'
    else if (code === 'nothing-open') return 'No document is open on the tablet.'
    else if (code === 'password-missing') return 'Set a password for the saved host first.'
    else if (code === 'settings-incomplete') return 'Save a host and fingerprint first.'
    else if (code === 'sidecar-damaged') return 'The installed dependencies are damaged. Repair them.'
    else if (code === 'sidecar-not-installed') return 'Install the reMarkable dependencies first.'
    else if (code === 'timeout') return 'The tablet did not answer before the timeout.'
    else if (code === 'unsupported-platform') return 'This platform is not supported.'
    else if (code === 'web-interface-unavailable') return 'Enable the Web Interface on the tablet.'
    else if (code === 'cli-failed') return 'The reMarkable tool failed.'
    else {
      const unhandled: never = code
      throw new Error(`Unknown reMarkable failure code: ${String(unhandled)}`)
    }
  }
}
