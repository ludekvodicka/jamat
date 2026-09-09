import type {
  RemoteOutboundConnectionStatus,
} from '../../../../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type {
  RemoteControlPeerEndpoint,
} from '../../../../../../lib-orchestrator/remoteControl/remoteControlPeerApi.types'
import {
  RemoteControlSettings,
  type RemoteControlListenerSettings,
} from '../../../../../shared/remoteControlSettings'
import type {
  RemoteListenerRuntime,
  RemoteSettingsRefusalCode,
  RemoteSettingsSnapshotDto,
} from '../../../../../shared/remoteSettingsSnapshot'
import {
  SettingsCard,
  type SettingsCardEffect,
  type SettingsCardInput,
  type SettingsCardState,
} from '../../settingsCard'

/**
 * What one click asks the main process for. Everything below the listener form is an immediate
 * command rather than a buffer: there is nothing to be unsaved about a Retry, and a right kept in a
 * buffer would be a second answer to a question the profile already answers.
 */
export type RemoteControlSettingsCommand =
  | { command: 'copy-bundle' }
  | { command: 'pairing-connect' }
  | { command: 'profile-endpoint'; profileId: string }
  | { command: 'profile-retry'; profileId: string }
  | { command: 'profile-forget'; profileId: string }
  /**
   * The endpoint id alone, because that is what one Allowed-in ROW is: the computer id is carried
   * by the effect, which is the thing that has to reach the right pair in the trust file.
   */
  | { command: 'inbound-revoke'; remoteEndpointId: string }

/** What the last command left on screen, beside the section that ran it. */
export interface RemoteControlSettingsOutcome {
  command: RemoteControlSettingsCommand
  text: string
  failed: boolean
}

export interface RemoteControlSettingsEndpointEdit {
  profileId: string
  host: string
  /** Text until it is committed: a half-typed port must not become a number nobody meant. */
  port: string
}

/** The card's five inputs minus the one this screen feeds itself out of the snapshot. */
type RemoteListenerCardInput =
  Exclude<SettingsCardInput<RemoteControlListenerSettings>, { input: 'loaded' }>

/** The card's two effects minus `load`: what reads this screen is a snapshot reader, not a card. */
type RemoteListenerCardEffect =
  Extract<SettingsCardEffect<RemoteControlListenerSettings>, { effect: 'save' }>

export interface RemoteControlSettingsModelState {
  /** The whole credential-free document, or null while the first read is still out. */
  snapshot: RemoteSettingsSnapshotDto | null
  /** The listener form, and the only thing on this screen that can hold unsaved work. */
  listener: SettingsCardState<RemoteControlListenerSettings>
  /**
   * The one connect field, holding either form: a pasted bundle or a typed `host:port`. Which of
   * the two it got is the main process's decision, never this screen's.
   */
  pairing: { text: string }
  /** The one endpoint row open for editing; a second would be two rows claiming one profile. */
  endpointEdit: RemoteControlSettingsEndpointEdit | null
  /** The paired computer whose Forget is armed and waiting for the second click. */
  forgetAsk: string | null
  /** The one command in flight. A second is refused rather than raced over the same section. */
  running: RemoteControlSettingsCommand | null
  outcome: RemoteControlSettingsOutcome | null
  /** The snapshot reader gave up, which is a different failure from a command being refused. */
  readProblem: string | null
}

export type RemoteControlSettingsInput =
  | RemoteListenerCardInput
  | { input: 'snapshot'; value: RemoteSettingsSnapshotDto }
  /**
   * Named `problem` rather than `detail` on purpose: the shared card reads a `detail` off every
   * input it is handed, and its own is a string where this one is null the moment a read works.
   */
  | { input: 'read-problem'; problem: string | null }
  | { input: 'listener-enabled'; value: boolean }
  | { input: 'listener-bind-host'; value: string }
  | { input: 'listener-port'; value: number }
  | { input: 'listener-advertised-host'; value: string }
  | { input: 'copy-bundle' }
  | { input: 'pairing-text'; value: string }
  | { input: 'pairing-connect' }
  | { input: 'inbound-revoke'; remoteComputerId: string; remoteEndpointId: string }
  | { input: 'profile-retry'; profileId: string }
  | { input: 'endpoint-open'; profileId: string; endpoint: RemoteControlPeerEndpoint }
  | { input: 'endpoint-host'; value: string }
  | { input: 'endpoint-port'; value: string }
  | { input: 'endpoint-cancel' }
  | { input: 'endpoint-save' }
  | { input: 'forget-ask'; profileId: string }
  | { input: 'forget-cancel' }
  | { input: 'forget-confirm' }
  /** `refusal` is null when the command landed; the note a person reads is this model's own. */
  | { input: 'settled'; refusal: string | null }

export type RemoteControlSettingsEffect =
  | RemoteListenerCardEffect
  | { effect: 'copy-bundle'; text: string }
  | { effect: 'pairing-connect'; text: string }
  | { effect: 'profile-endpoint'; profileId: string; endpoint: RemoteControlPeerEndpoint }
  | { effect: 'profile-retry'; profileId: string }
  | { effect: 'profile-forget'; profileId: string }
  | { effect: 'inbound-revoke'; remoteComputerId: string; remoteEndpointId: string }

export interface RemoteControlSettingsStep {
  state: RemoteControlSettingsModelState
  effects: readonly RemoteControlSettingsEffect[]
}

/**
 * The Remote connections screen as data: the computers this one dials, and what this computer lets
 * in.
 *
 * One buffer and seven commands. The listener form is the buffer, because a bind is worth deciding
 * before it is asked for; everything else changes a right the moment it is clicked, and a right held
 * in a buffer is a right the screen claims to have that the trust file has never heard of.
 *
 * The document itself is never loaded from here. `remote:changed` carries nothing and the value
 * rides on the get, so the reader that owns the coalescing and the backoff pushes snapshots IN -
 * which is also why `initial` emits no effect at all.
 */
export class RemoteControlSettingsModel {
  static initial(): RemoteControlSettingsStep {
    return {
      state: {
        snapshot: null,
        listener: { loaded: null, buffer: null, saving: null, problem: null },
        pairing: { text: '' },
        endpointEdit: null,
        forgetAsk: null,
        running: null,
        outcome: null,
        readProblem: null,
      },
      effects: [],
    }
  }

  static isModified(state: RemoteControlSettingsModelState): boolean {
    return SettingsCard.isModified(state.listener, (loaded, buffer) =>
      loaded.enabled === buffer.enabled
      && loaded.bindHost === buffer.bindHost
      && loaded.port === buffer.port
      && loaded.advertisedHost === buffer.advertisedHost)
  }

  /**
   * A section its own owner cannot read is a section nothing may write over: the next save would
   * replace what is in the file rather than repair it. The screen says so and refuses every write;
   * reading it, and the fingerprint and the runtime state, still works.
   */
  static locked(state: RemoteControlSettingsModelState): boolean {
    return state.snapshot === null || state.snapshot.sectionDamaged
  }

  /** What the listener is really doing, as opposed to what the file asks of it. */
  static runtimeTextOf(runtime: RemoteListenerRuntime): string {
    if (runtime.status === 'disabled') return 'disabled'
    else if (runtime.status === 'starting') return 'starting…'
    else if (runtime.status === 'listening')
      return `listening on ${runtime.actualHost}:${runtime.actualPort}`
    else if (runtime.status === 'failed') return `failed: ${runtime.error}`
    else throw new Error(`Unknown remote listener runtime: ${JSON.stringify(runtime)}`)
  }

  static statusTextOf(status: RemoteOutboundConnectionStatus): string {
    if (status === 'connected') return 'connected'
    else if (status === 'connecting') return 'connecting…'
    else if (status === 'offline') return 'offline'
    // Not a fault and not a setting: this computer is reached when something needs it, and while
    // this screen is open something does - so a row reading idle here is one that has not answered
    // yet rather than one nobody is dialling.
    else if (status === 'idle') return 'idle, nothing is asking for it'
    else throw new Error(`Unknown remote outbound status: ${JSON.stringify(status)}`)
  }

  /**
   * A refusal in the words of the person who clicked. The codes are the settings service's
   * vocabulary and these are the screen's, so a tenth refusal has to be given a sentence here before
   * it can reach anybody as a word they have no sentence for.
   */
  static refusalTextOf(refusal: { code: RemoteSettingsRefusalCode; detail: string }): string {
    return `${RemoteControlSettingsModel.refusalSentenceOf(refusal.code)} (${refusal.detail})`
  }

  static transition(
    state: RemoteControlSettingsModelState,
    input: RemoteControlSettingsInput,
  ): RemoteControlSettingsStep {
    // Before the shared arms, because `save` is one of them and a damaged section refuses writes.
    if (input.input === 'save' && RemoteControlSettingsModel.locked(state))
      return RemoteControlSettingsModel.step(state)
    const shared = SettingsCard.transition<RemoteControlListenerSettings, RemoteListenerCardEffect>(
      state.listener,
      input,
      () => RemoteControlSettings.defaultValue().listener,
    )
    if (shared !== null)
      return { state: { ...state, listener: shared.state }, effects: shared.effects }

    if (input.input === 'snapshot')
      return RemoteControlSettingsModel.arrived(state, input.value)
    else if (input.input === 'read-problem')
      return RemoteControlSettingsModel.step({ ...state, readProblem: input.problem })
    else if (input.input === 'listener-enabled')
      return RemoteControlSettingsModel.listenerEdit(state, (buffer) =>
        ({ ...buffer, enabled: input.value }))
    else if (input.input === 'listener-bind-host')
      return RemoteControlSettingsModel.listenerEdit(state, (buffer) =>
        ({ ...buffer, bindHost: input.value }))
    else if (input.input === 'listener-port')
      return RemoteControlSettingsModel.listenerEdit(state, (buffer) =>
        ({ ...buffer, port: input.value }))
    else if (input.input === 'listener-advertised-host')
      return RemoteControlSettingsModel.listenerEdit(state, (buffer) =>
        ({ ...buffer, advertisedHost: input.value }))
    else if (input.input === 'copy-bundle')
      return RemoteControlSettingsModel.copyBundle(state)
    else if (input.input === 'pairing-text')
      return RemoteControlSettingsModel.step({
        ...state,
        pairing: { ...state.pairing, text: input.value },
      })
    else if (input.input === 'pairing-connect')
      return RemoteControlSettingsModel.connectPairing(state)
    else if (input.input === 'inbound-revoke')
      return RemoteControlSettingsModel.started(
        state,
        { command: 'inbound-revoke', remoteEndpointId: input.remoteEndpointId },
        {
          effect: 'inbound-revoke',
          remoteComputerId: input.remoteComputerId,
          remoteEndpointId: input.remoteEndpointId,
        },
      )
    else if (input.input === 'profile-retry')
      return RemoteControlSettingsModel.started(
        state,
        { command: 'profile-retry', profileId: input.profileId },
        { effect: 'profile-retry', profileId: input.profileId },
      )
    else if (input.input === 'endpoint-open')
      return RemoteControlSettingsModel.step({
        ...state,
        endpointEdit: {
          profileId: input.profileId,
          host: input.endpoint.host,
          port: String(input.endpoint.port),
        },
      })
    else if (input.input === 'endpoint-host')
      return RemoteControlSettingsModel.endpointEdit(state, (edit) =>
        ({ ...edit, host: input.value }))
    else if (input.input === 'endpoint-port')
      return RemoteControlSettingsModel.endpointEdit(state, (edit) =>
        ({ ...edit, port: input.value }))
    else if (input.input === 'endpoint-cancel')
      return RemoteControlSettingsModel.step({ ...state, endpointEdit: null })
    else if (input.input === 'endpoint-save')
      return RemoteControlSettingsModel.saveEndpoint(state)
    else if (input.input === 'forget-ask')
      return RemoteControlSettingsModel.step({ ...state, forgetAsk: input.profileId })
    else if (input.input === 'forget-cancel')
      return RemoteControlSettingsModel.step({ ...state, forgetAsk: null })
    else if (input.input === 'forget-confirm')
      return RemoteControlSettingsModel.forget(state)
    else if (input.input === 'settled')
      return RemoteControlSettingsModel.settled(state, input.refusal)
    else
      throw new Error(`Unknown remote control settings input: ${JSON.stringify(input)}`)
  }

  /**
   * A fresh document, and the one rule that keeps it from stealing what somebody is typing: the
   * listener form takes the configured value only while it holds no edit and no write is in flight.
   * The rest of the screen is the snapshot drawn, so it always moves.
   */
  private static arrived(
    state: RemoteControlSettingsModelState,
    value: RemoteSettingsSnapshotDto,
  ): RemoteControlSettingsStep {
    const settled = state.listener.saving === null && !RemoteControlSettingsModel.isModified(state)
    const configured = { ...value.listener.configured }
    const profileIds = new Set(value.profiles.map((profile) => profile.profileId))
    return RemoteControlSettingsModel.step({
      ...state,
      snapshot: value,
      listener: settled
        ? { ...state.listener, loaded: configured, buffer: configured }
        : state.listener,
      // A row that is gone takes its armed Forget and its open endpoint editor with it, rather
      // than leaving either pointing at a profile a CLI import replaced while this screen was open.
      endpointEdit: state.endpointEdit !== null && profileIds.has(state.endpointEdit.profileId)
        ? state.endpointEdit
        : null,
      forgetAsk: state.forgetAsk !== null && profileIds.has(state.forgetAsk)
        ? state.forgetAsk
        : null,
    })
  }

  private static listenerEdit(
    state: RemoteControlSettingsModelState,
    change: (buffer: RemoteControlListenerSettings) => RemoteControlListenerSettings,
  ): RemoteControlSettingsStep {
    if (state.listener.buffer === null || RemoteControlSettingsModel.locked(state))
      return RemoteControlSettingsModel.step(state)
    return RemoteControlSettingsModel.step({
      ...state,
      listener: { ...state.listener, buffer: change(state.listener.buffer) },
    })
  }

  private static endpointEdit(
    state: RemoteControlSettingsModelState,
    change: (edit: RemoteControlSettingsEndpointEdit) => RemoteControlSettingsEndpointEdit,
  ): RemoteControlSettingsStep {
    if (state.endpointEdit === null) return RemoteControlSettingsModel.step(state)
    return RemoteControlSettingsModel.step({
      ...state,
      endpointEdit: change(state.endpointEdit),
    })
  }

  private static copyBundle(state: RemoteControlSettingsModelState): RemoteControlSettingsStep {
    const text = state.snapshot?.bundleText ?? null
    // Nothing was published, so there is nothing to copy: an empty clipboard would read as a bundle.
    if (text === null) return RemoteControlSettingsModel.step(state)
    return RemoteControlSettingsModel.started(
      state,
      { command: 'copy-bundle' },
      { effect: 'copy-bundle', text },
    )
  }

  /**
   * The one connect field, sent as it was typed. Which form it holds is not decided here: an empty
   * field is the only thing this screen can rule on without knowing what a bundle or an address is.
   */
  private static connectPairing(state: RemoteControlSettingsModelState): RemoteControlSettingsStep {
    const text = state.pairing.text.trim()
    if (text === '')
      return RemoteControlSettingsModel.refused(
        state,
        { command: 'pairing-connect' },
        'Paste the other computer’s pairing bundle, or type its host:port, first.',
      )
    return RemoteControlSettingsModel.started(
      state,
      { command: 'pairing-connect' },
      { effect: 'pairing-connect', text },
    )
  }

  private static saveEndpoint(state: RemoteControlSettingsModelState): RemoteControlSettingsStep {
    const edit = state.endpointEdit
    if (edit === null) return RemoteControlSettingsModel.step(state)
    const command: RemoteControlSettingsCommand = {
      command: 'profile-endpoint',
      profileId: edit.profileId,
    }
    const host = edit.host.trim()
    if (host === '')
      return RemoteControlSettingsModel.refused(state, command, 'An endpoint needs a host.')
    const port = Number(edit.port)
    if (!Number.isSafeInteger(port)
      || port < RemoteControlSettings.portMinConst
      || port > RemoteControlSettings.portMaxConst)
      return RemoteControlSettingsModel.refused(
        state,
        command,
        `A port is a whole number between ${RemoteControlSettings.portMinConst} and `
        + `${RemoteControlSettings.portMaxConst}.`,
      )
    return RemoteControlSettingsModel.started(
      state,
      command,
      { effect: 'profile-endpoint', profileId: edit.profileId, endpoint: { host, port } },
    )
  }

  private static forget(state: RemoteControlSettingsModelState): RemoteControlSettingsStep {
    const profileId = state.forgetAsk
    // Nothing is armed, so nothing is forgotten: the second click IS the confirmation.
    if (profileId === null) return RemoteControlSettingsModel.step(state)
    return RemoteControlSettingsModel.started(
      state,
      { command: 'profile-forget', profileId },
      { effect: 'profile-forget', profileId },
    )
  }

  private static started(
    state: RemoteControlSettingsModelState,
    command: RemoteControlSettingsCommand,
    effect: RemoteControlSettingsEffect,
  ): RemoteControlSettingsStep {
    if (state.running !== null || RemoteControlSettingsModel.locked(state))
      return RemoteControlSettingsModel.step(state)
    return RemoteControlSettingsModel.step(
      { ...state, running: command, outcome: null },
      effect,
    )
  }

  /** A command the screen itself refused, which never leaves the renderer and never starts a run. */
  private static refused(
    state: RemoteControlSettingsModelState,
    command: RemoteControlSettingsCommand,
    text: string,
  ): RemoteControlSettingsStep {
    return RemoteControlSettingsModel.step({
      ...state,
      outcome: { command, text, failed: true },
    })
  }

  private static settled(
    state: RemoteControlSettingsModelState,
    refusal: string | null,
  ): RemoteControlSettingsStep {
    const command = state.running
    // An answer with nothing running belongs to a command this screen has already forgotten.
    if (command === null) return RemoteControlSettingsModel.step(state)
    if (refusal !== null)
      return RemoteControlSettingsModel.step({
        ...state,
        running: null,
        outcome: { command, text: refusal, failed: true },
      })
    return RemoteControlSettingsModel.step({
      ...state,
      running: null,
      outcome: { command, text: RemoteControlSettingsModel.successTextOf(command), failed: false },
      // What each command leaves behind on the surface that ran it. The new snapshot is what
      // redraws the row itself; these are the controls that asked for the change.
      pairing: command.command === 'pairing-connect'
        ? { ...state.pairing, text: '' }
        : state.pairing,
      endpointEdit: command.command === 'profile-endpoint' ? null : state.endpointEdit,
      forgetAsk: command.command === 'profile-forget' ? null : state.forgetAsk,
    })
  }

  private static successTextOf(command: RemoteControlSettingsCommand): string {
    if (command.command === 'copy-bundle') return 'The pairing bundle is on the clipboard.'
    else if (command.command === 'pairing-connect') return 'That computer is paired.'
    else if (command.command === 'profile-endpoint') return 'The endpoint is changed.'
    else if (command.command === 'profile-retry') return 'Dialling that computer now.'
    else if (command.command === 'profile-forget') return 'That computer is forgotten.'
    else if (command.command === 'inbound-revoke')
      return 'That computer may no longer reach this one.'
    else throw new Error(`Unknown remote control settings command: ${JSON.stringify(command)}`)
  }

  private static refusalSentenceOf(code: RemoteSettingsRefusalCode): string {
    if (code === 'busy') return 'Another change to the listener is still running.'
    else if (code === 'stopping') return 'The client is quitting and took no further change.'
    else if (code === 'bind-failed') return 'That address and port could not be bound.'
    else if (code === 'config-refused') return 'config.json refused the write.'
    else if (code === 'invalid-bundle') return 'That is not a pairing bundle this build can read.'
    else if (code === 'probe-failed')
      return 'That address did not answer with pairing info; check the address and the listener '
        + 'on that computer, or paste its bundle instead.'
    else if (code === 'identity-conflict')
      return 'Another paired computer already claims that identity.'
    else if (code === 'not-confirmed') return 'The change was not confirmed on this computer.'
    else if (code === 'not-found') return 'That paired computer is no longer there.'
    else throw new Error(`Unknown remote settings refusal: ${JSON.stringify(code)}`)
  }

  private static step(
    state: RemoteControlSettingsModelState,
    ...effects: readonly RemoteControlSettingsEffect[]
  ): RemoteControlSettingsStep {
    return { state, effects }
  }
}
