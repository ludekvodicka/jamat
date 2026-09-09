import type {
  RemarkableDependencyStatus,
  RemarkableErrorCode,
  RemarkableSettingsSnapshot,
} from '../../../../../shared/remarkableApi.types'
import {
  RemarkableSettings,
  type RemarkableSettingsValue,
} from '../../../../../shared/remarkableSettings'
import {
  SettingsCard,
  type SettingsCardEffect,
  type SettingsCardInput,
  type SettingsCardState,
} from '../../settingsCard'

export type RemarkableSettingsMachineAction =
  | 'install-dependencies'
  | 'detect-fingerprint'
  | 'set-password'
  | 'clear-password'
  | 'test-connection'

export type RemarkableSettingsFailureCode = RemarkableErrorCode | 'transport'

export type RemarkableSettingsActionResult<TValue = undefined> =
  | { ok: true; value: TValue }
  | { ok: false; code: RemarkableSettingsFailureCode; detail: string }

export interface RemarkableSettingsProblem {
  action: RemarkableSettingsMachineAction | 'dependencies-status'
  code: RemarkableSettingsFailureCode
  detail: string
}

/**
 * The setup has an order, and the card used to hide it: its sections read Device, Password,
 * Dependencies, Connection, which is almost exactly the reverse of the only sequence that works.
 * A user typed a host, pressed Detect and was told a password was missing "for the saved host", a
 * phrase naming state the card never showed. The order lives here so the card can draw it and a
 * test can hold it.
 */
export const remarkableSetupOrderConst = [
  'dependencies',
  'host',
  'password',
  'fingerprint',
  'connection',
] as const

export type RemarkableSetupStepId = typeof remarkableSetupOrderConst[number]

/** What the step needs from an EARLIER step before its own action can run. */
export type RemarkableSetupBlocker =
  | 'dependencies-missing'
  | 'host-missing'
  | 'host-unsaved'
  | 'password-missing'
  | 'fingerprint-missing'

export interface RemarkableSetupStep {
  id: RemarkableSetupStepId
  position: number
  done: boolean
  blockedBy: RemarkableSetupBlocker | null
}

export interface RemarkableSettingsModelState {
  persisted: SettingsCardState<RemarkableSettingsValue>
  dependencies: RemarkableDependencyStatus | null
  passwordDraft: string
  passwordConfiguredForHost: string | null
  fingerprintCandidate: { host: string; fingerprint: string } | null
  connectionTest: RemarkableSettingsActionResult | null
  running: RemarkableSettingsMachineAction | null
  actionProblem: RemarkableSettingsProblem | null
}

type RemarkableSettingsCardInput = Exclude<
  SettingsCardInput<RemarkableSettingsValue>,
  { input: 'loaded' }
>

export type RemarkableSettingsInput =
  | RemarkableSettingsCardInput
  | {
    input: 'loaded'
    value: RemarkableSettingsSnapshot['value']
    passwordConfigured: boolean
  }
  | { input: 'dependencies-loaded'; status: RemarkableDependencyStatus }
  | { input: 'dependencies-status-failed'; detail: string }
  | { input: 'host'; value: string }
  | { input: 'timeout'; value: number }
  | { input: 'confirm-fingerprint' }
  | { input: 'password-draft'; value: string }
  | { input: 'install-dependencies' }
  | {
    input: 'dependencies-installed'
    result: RemarkableSettingsActionResult<RemarkableDependencyStatus>
  }
  | { input: 'detect-fingerprint' }
  | {
    input: 'fingerprint-detected'
    expectedHost: string
    result: RemarkableSettingsActionResult<{ host: string; fingerprint: string }>
  }
  | { input: 'set-password' }
  | {
    input: 'password-settled'
    storedHost: string
    result: RemarkableSettingsActionResult
  }
  | { input: 'clear-password' }
  | { input: 'password-cleared'; result: RemarkableSettingsActionResult }
  | { input: 'test-connection' }
  | { input: 'connection-tested'; result: RemarkableSettingsActionResult }

export type RemarkableSettingsEffect =
  | SettingsCardEffect<RemarkableSettingsValue>
  | { effect: 'dependencies-status' }
  | { effect: 'dependencies-install' }
  | { effect: 'fingerprint-detect'; expectedHost: string }
  | { effect: 'password-set'; storedHost: string; password: string }
  | { effect: 'password-clear'; storedHost: string }
  | { effect: 'connection-test' }

export interface RemarkableSettingsStep {
  state: RemarkableSettingsModelState
  effects: readonly RemarkableSettingsEffect[]
}

export class RemarkableSettingsModel {
  static initial(): RemarkableSettingsStep {
    const persisted = SettingsCard.initial<RemarkableSettingsValue, SettingsCardEffect<RemarkableSettingsValue>>()
    return {
      state: {
        persisted: persisted.state,
        dependencies: null,
        passwordDraft: '',
        passwordConfiguredForHost: null,
        fingerprintCandidate: null,
        connectionTest: null,
        running: null,
        actionProblem: null,
      },
      effects: [...persisted.effects, { effect: 'dependencies-status' }],
    }
  }

  static isModified(state: RemarkableSettingsModelState): boolean {
    return SettingsCard.isModified(state.persisted, (loaded, buffer) =>
      loaded.host === buffer.host
      && loaded.fingerprint === buffer.fingerprint
      && loaded.timeoutMilliseconds === buffer.timeoutMilliseconds)
  }

  static storedHost(state: RemarkableSettingsModelState): string | null {
    return state.persisted.loaded?.host ?? null
  }

  static passwordConfigured(state: RemarkableSettingsModelState): boolean {
    const host = RemarkableSettingsModel.storedHost(state)
    return host !== null && state.passwordConfiguredForHost === host
  }

  static dependenciesReady(state: RemarkableSettingsModelState): boolean {
    return state.dependencies?.kind === 'ready'
  }

  static fingerprintPinned(state: RemarkableSettingsModelState): boolean {
    return RemarkableSettings.isValidFingerprint(state.persisted.loaded?.fingerprint)
  }

  static setupSteps(state: RemarkableSettingsModelState): readonly RemarkableSetupStep[] {
    return remarkableSetupOrderConst.map((id, index) => ({
      id,
      position: index + 1,
      done: RemarkableSettingsModel.setupDone(state, id),
      blockedBy: RemarkableSettingsModel.setupBlocker(state, id),
    }))
  }

  private static setupDone(
    state: RemarkableSettingsModelState,
    id: RemarkableSetupStepId,
  ): boolean {
    if (id === 'dependencies') return RemarkableSettingsModel.dependenciesReady(state)
    else if (id === 'host') return RemarkableSettingsModel.storedHost(state) !== null
    else if (id === 'password') return RemarkableSettingsModel.passwordConfigured(state)
    else if (id === 'fingerprint') return RemarkableSettingsModel.fingerprintPinned(state)
    else if (id === 'connection') return state.connectionTest?.ok === true
    else {
      const unhandled: never = id
      throw new Error(`Unknown reMarkable setup step: ${JSON.stringify(unhandled)}`)
    }
  }

  /**
   * Only what an EARLIER step owes this one, and only the first thing missing: a list of five
   * complaints is not more helpful than the one the user has to fix next.
   */
  private static setupBlocker(
    state: RemarkableSettingsModelState,
    id: RemarkableSetupStepId,
  ): RemarkableSetupBlocker | null {
    if (id === 'dependencies' || id === 'host') return null
    if (id === 'password') return RemarkableSettingsModel.hostBlocker(state)
    if (id === 'fingerprint' || id === 'connection') {
      if (!RemarkableSettingsModel.dependenciesReady(state)) return 'dependencies-missing'
      const host = RemarkableSettingsModel.hostBlocker(state)
      if (host !== null) return host
      if (!RemarkableSettingsModel.passwordConfigured(state)) return 'password-missing'
      // Detection is the one device command that runs before a pin exists, so only the test needs it.
      if (id === 'connection' && !RemarkableSettingsModel.fingerprintPinned(state))
        return 'fingerprint-missing'
      return null
    }
    const unhandled: never = id
    throw new Error(`Unknown reMarkable setup step: ${JSON.stringify(unhandled)}`)
  }

  private static hostBlocker(
    state: RemarkableSettingsModelState,
  ): RemarkableSetupBlocker | null {
    if (RemarkableSettingsModel.storedHost(state) === null) return 'host-missing'
    // The password is encrypted against the SAVED host, so an edited buffer has nothing to bind to.
    if (RemarkableSettingsModel.isModified(state)) return 'host-unsaved'
    return null
  }

  static transition(
    state: RemarkableSettingsModelState,
    input: RemarkableSettingsInput,
  ): RemarkableSettingsStep {
    const shared = SettingsCard.transition<RemarkableSettingsValue, SettingsCardEffect<RemarkableSettingsValue>>(
      state.persisted,
      input,
      (buffer) => RemarkableSettingsModel.resetPersisted(buffer),
    )
    if (shared !== null) {
      let next: RemarkableSettingsModelState = { ...state, persisted: shared.state }
      if (input.input === 'loaded')
        next = {
          ...next,
          passwordConfiguredForHost: input.passwordConfigured ? input.value.host ?? null : null,
        }
      else if (input.input === 'reset')
        next = { ...next, fingerprintCandidate: null, connectionTest: null }
      return { state: next, effects: shared.effects }
    }

    if (input.input === 'dependencies-loaded')
      return RemarkableSettingsModel.step({
        ...state,
        dependencies: input.status,
        actionProblem: state.actionProblem?.action === 'dependencies-status'
          ? null
          : state.actionProblem,
      })
    else if (input.input === 'dependencies-status-failed')
      return RemarkableSettingsModel.step({
        ...state,
        actionProblem: {
          action: 'dependencies-status',
          code: 'transport',
          detail: input.detail,
        },
      })
    else if (input.input === 'host')
      return RemarkableSettingsModel.editHost(state, input.value)
    else if (input.input === 'timeout')
      return RemarkableSettingsModel.edited(state, (buffer) => ({
        ...buffer,
        timeoutMilliseconds: input.value,
      }))
    else if (input.input === 'confirm-fingerprint')
      return RemarkableSettingsModel.confirmFingerprint(state)
    else if (input.input === 'password-draft')
      return RemarkableSettingsModel.step({ ...state, passwordDraft: input.value })
    else if (input.input === 'install-dependencies')
      return RemarkableSettingsModel.started(state, 'install-dependencies', {
        effect: 'dependencies-install',
      })
    else if (input.input === 'dependencies-installed')
      return RemarkableSettingsModel.dependenciesInstalled(state, input.result)
    else if (input.input === 'detect-fingerprint')
      return RemarkableSettingsModel.detectFingerprint(state)
    else if (input.input === 'fingerprint-detected')
      return RemarkableSettingsModel.fingerprintDetected(
        state,
        input.expectedHost,
        input.result,
      )
    else if (input.input === 'set-password')
      return RemarkableSettingsModel.setPassword(state)
    else if (input.input === 'password-settled')
      return RemarkableSettingsModel.passwordSettled(state, input.storedHost, input.result)
    else if (input.input === 'clear-password')
      return RemarkableSettingsModel.clearPassword(state)
    else if (input.input === 'password-cleared')
      return RemarkableSettingsModel.passwordCleared(state, input.result)
    else if (input.input === 'test-connection')
      return RemarkableSettingsModel.testConnection(state)
    else if (input.input === 'connection-tested')
      return RemarkableSettingsModel.connectionTested(state, input.result)
    else
      throw new Error(`Unknown reMarkable settings input: ${String((input as { input?: unknown }).input)}`)
  }

  private static resetPersisted(buffer: RemarkableSettingsValue): RemarkableSettingsValue {
    const reset = {
      ...buffer,
      timeoutMilliseconds: RemarkableSettings.timeoutMillisecondsDefaultConst,
    }
    delete reset.host
    delete reset.fingerprint
    return reset
  }

  private static editHost(
    state: RemarkableSettingsModelState,
    value: string,
  ): RemarkableSettingsStep {
    const buffer = state.persisted.buffer
    if (buffer === null) return RemarkableSettingsModel.step(state)
    const edited = { ...buffer }
    if (value === '') delete edited.host
    else edited.host = value
    delete edited.fingerprint
    return RemarkableSettingsModel.step({
      ...state,
      persisted: { ...state.persisted, buffer: edited },
      fingerprintCandidate: null,
      connectionTest: null,
    })
  }

  private static edited(
    state: RemarkableSettingsModelState,
    change: (buffer: RemarkableSettingsValue) => RemarkableSettingsValue,
  ): RemarkableSettingsStep {
    const buffer = state.persisted.buffer
    if (buffer === null) return RemarkableSettingsModel.step(state)
    return RemarkableSettingsModel.step({
      ...state,
      persisted: { ...state.persisted, buffer: change(buffer) },
      connectionTest: null,
    })
  }

  /**
   * Pinning writes the fingerprint immediately, and this button IS the explicit confirmation the
   * pinning rule asks for: a detected value is never accepted on its own, and it never overwrites a
   * stored one without this click. Leaving it in the buffer for the bottom Save was a second,
   * unrelated-looking step in another part of the card, so a pinned-looking fingerprint could sit
   * there unsaved.
   *
   * Detection already refuses to run while anything else is edited, so the buffer here differs from
   * what is stored by the fingerprint alone; the guard keeps that true even if an edit lands between
   * the detection and this click.
   */
  private static confirmFingerprint(state: RemarkableSettingsModelState): RemarkableSettingsStep {
    const candidate = state.fingerprintCandidate
    const buffer = state.persisted.buffer
    if (candidate === null
      || buffer === null
      || buffer.host !== candidate.host
      || state.persisted.saving !== null
      || RemarkableSettingsModel.isModified(state))
      return RemarkableSettingsModel.step(state)
    const pinned = { ...buffer, fingerprint: candidate.fingerprint }
    return RemarkableSettingsModel.step(
      {
        ...state,
        persisted: { ...state.persisted, buffer: pinned, saving: pinned, problem: null },
        fingerprintCandidate: null,
        connectionTest: null,
      },
      { effect: 'save', value: pinned },
    )
  }

  private static detectFingerprint(state: RemarkableSettingsModelState): RemarkableSettingsStep {
    const storedHost = RemarkableSettingsModel.storedHost(state)
    if (state.running !== null
      || storedHost === null
      || RemarkableSettingsModel.isModified(state))
      return RemarkableSettingsModel.step(state)
    return RemarkableSettingsModel.started({ ...state, fingerprintCandidate: null }, 'detect-fingerprint', {
      effect: 'fingerprint-detect',
      expectedHost: storedHost,
    })
  }

  private static fingerprintDetected(
    state: RemarkableSettingsModelState,
    expectedHost: string,
    result: RemarkableSettingsActionResult<{ host: string; fingerprint: string }>,
  ): RemarkableSettingsStep {
    if (state.running !== 'detect-fingerprint') return RemarkableSettingsModel.step(state)
    if (!result.ok)
      return RemarkableSettingsModel.failedAction(state, 'detect-fingerprint', result)
    const currentHost = state.persisted.buffer?.host
    return RemarkableSettingsModel.step({
      ...state,
      running: null,
      fingerprintCandidate: currentHost === expectedHost && result.value.host === expectedHost
        ? result.value
        : null,
    })
  }

  private static setPassword(state: RemarkableSettingsModelState): RemarkableSettingsStep {
    const storedHost = RemarkableSettingsModel.storedHost(state)
    if (state.running !== null
      || storedHost === null
      || state.passwordDraft.length === 0
      || RemarkableSettingsModel.isModified(state))
      return RemarkableSettingsModel.step(state)
    const password = state.passwordDraft
    return RemarkableSettingsModel.started(
      { ...state, passwordDraft: '', connectionTest: null },
      'set-password',
      { effect: 'password-set', storedHost, password },
    )
  }

  private static passwordSettled(
    state: RemarkableSettingsModelState,
    storedHost: string,
    result: RemarkableSettingsActionResult,
  ): RemarkableSettingsStep {
    if (state.running !== 'set-password') return RemarkableSettingsModel.step(state)
    if (!result.ok)
      return RemarkableSettingsModel.failedAction(
        { ...state, passwordDraft: '' },
        'set-password',
        result,
      )
    return RemarkableSettingsModel.step({
      ...state,
      passwordDraft: '',
      passwordConfiguredForHost: storedHost,
      running: null,
      actionProblem: null,
    })
  }

  private static clearPassword(state: RemarkableSettingsModelState): RemarkableSettingsStep {
    const storedHost = RemarkableSettingsModel.storedHost(state)
    if (state.running !== null
      || storedHost === null
      || !RemarkableSettingsModel.passwordConfigured(state))
      return RemarkableSettingsModel.step(state)
    return RemarkableSettingsModel.started(
      { ...state, passwordDraft: '', connectionTest: null },
      'clear-password',
      { effect: 'password-clear', storedHost },
    )
  }

  private static passwordCleared(
    state: RemarkableSettingsModelState,
    result: RemarkableSettingsActionResult,
  ): RemarkableSettingsStep {
    if (state.running !== 'clear-password') return RemarkableSettingsModel.step(state)
    if (!result.ok)
      return RemarkableSettingsModel.failedAction(
        { ...state, passwordDraft: '' },
        'clear-password',
        result,
      )
    return RemarkableSettingsModel.step({
      ...state,
      passwordDraft: '',
      passwordConfiguredForHost: null,
      running: null,
      actionProblem: null,
    })
  }

  private static dependenciesInstalled(
    state: RemarkableSettingsModelState,
    result: RemarkableSettingsActionResult<RemarkableDependencyStatus>,
  ): RemarkableSettingsStep {
    if (state.running !== 'install-dependencies') return RemarkableSettingsModel.step(state)
    if (!result.ok)
      return RemarkableSettingsModel.failedAction(state, 'install-dependencies', result)
    return RemarkableSettingsModel.step({
      ...state,
      dependencies: result.value,
      running: null,
      actionProblem: null,
    })
  }

  private static testConnection(state: RemarkableSettingsModelState): RemarkableSettingsStep {
    if (state.running !== null
      || RemarkableSettingsModel.isModified(state)
      || !RemarkableSettingsModel.dependenciesReady(state))
      return RemarkableSettingsModel.step(state)
    return RemarkableSettingsModel.started(
      { ...state, connectionTest: null },
      'test-connection',
      { effect: 'connection-test' },
    )
  }

  private static connectionTested(
    state: RemarkableSettingsModelState,
    result: RemarkableSettingsActionResult,
  ): RemarkableSettingsStep {
    if (state.running !== 'test-connection') return RemarkableSettingsModel.step(state)
    return RemarkableSettingsModel.step({
      ...state,
      running: null,
      actionProblem: null,
      connectionTest: result,
    })
  }

  private static started(
    state: RemarkableSettingsModelState,
    action: RemarkableSettingsMachineAction,
    effect: RemarkableSettingsEffect,
  ): RemarkableSettingsStep {
    if (state.running !== null) return RemarkableSettingsModel.step(state)
    return RemarkableSettingsModel.step(
      { ...state, running: action, actionProblem: null },
      effect,
    )
  }

  private static failedAction(
    state: RemarkableSettingsModelState,
    action: RemarkableSettingsMachineAction,
    failure: { ok: false; code: RemarkableSettingsFailureCode; detail: string },
  ): RemarkableSettingsStep {
    return RemarkableSettingsModel.step({
      ...state,
      running: null,
      actionProblem: { action, code: failure.code, detail: failure.detail },
    })
  }

  private static step(
    state: RemarkableSettingsModelState,
    ...effects: readonly RemarkableSettingsEffect[]
  ): RemarkableSettingsStep {
    return { state, effects }
  }
}
