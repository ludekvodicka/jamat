import { describe, expect, it } from 'vitest'

import type {
  RemoteListenerRuntime,
  RemoteSettingsProfileDto,
  RemoteSettingsRefusalCode,
  RemoteSettingsSnapshotDto,
} from '../../../../../shared/remoteSettingsSnapshot'
import {
  RemoteControlSettingsModel,
  type RemoteControlSettingsInput,
  type RemoteControlSettingsModelState,
  type RemoteControlSettingsStep,
} from './remoteControlSettingsModel'

describe('app-client-ui/renderer/overlays/configuration/tabs/remoteControl/remoteControlSettingsModel', () => {
  function profileOf(
    overrides: Partial<RemoteSettingsProfileDto> = {},
  ): RemoteSettingsProfileDto {
    return {
      profileId: 'profile-a',
      displayName: 'Office PC',
      remoteComputerId: 'computer-a',
      remoteEndpointId: 'endpoint-a',
      configIdentity: 'jamat-v3',
      runtimeChannel: 'development',
      endpoint: { host: '203.0.113.10', port: 47_150 },
      fingerprint: 'fingerprint-a',
      status: 'offline',
      error: 'ECONNREFUSED',
      lastConnectedAt: null,
      nextRetryAt: null,
      applicationVersion: null,
      ...overrides,
    }
  }

  function snapshotOf(
    overrides: Partial<RemoteSettingsSnapshotDto> = {},
  ): RemoteSettingsSnapshotDto {
    return {
      identity: {
        remoteComputerId: 'computer-here',
        remoteEndpointId: 'endpoint-here',
        displayName: 'This PC',
        fingerprint: 'fingerprint-here',
        configIdentity: 'jamat-v3',
        runtimeChannel: 'development',
      },
      bundleText: '{"schemaVersion":1}',
      listener: {
        configured: { enabled: true, bindHost: '0.0.0.0', port: 47_150, advertisedHost: '10.0.0.2' },
        runtime: { status: 'listening', actualHost: '0.0.0.0', actualPort: 47_150 },
      },
      profiles: [profileOf()],
      inbound: [],
      sectionDamaged: false,
      ...overrides,
    }
  }

  /** The screen as it stands after its first snapshot, which is where every question below starts. */
  function loaded(snapshot: RemoteSettingsSnapshotDto = snapshotOf()): RemoteControlSettingsStep {
    return RemoteControlSettingsModel.transition(
      RemoteControlSettingsModel.initial().state,
      { input: 'snapshot', value: snapshot },
    )
  }

  function after(
    state: RemoteControlSettingsModelState,
    ...inputs: readonly RemoteControlSettingsInput[]
  ): RemoteControlSettingsStep {
    let step: RemoteControlSettingsStep = { state, effects: [] }
    for (const input of inputs)
      step = RemoteControlSettingsModel.transition(step.state, input)
    return step
  }

  it('reads nothing itself: the first step asks for no effect at all', () => {
    const start = RemoteControlSettingsModel.initial()

    expect(start.effects).toEqual([])
    expect(start.state.snapshot).toBeNull()
    expect(RemoteControlSettingsModel.locked(start.state)).toBe(true)
  })

  it('takes the configured listener into the form when a snapshot arrives', () => {
    const step = loaded()

    expect(step.state.listener.buffer)
      .toEqual({ enabled: true, bindHost: '0.0.0.0', port: 47_150, advertisedHost: '10.0.0.2' })
    expect(RemoteControlSettingsModel.isModified(step.state)).toBe(false)
    expect(step.state.snapshot?.profiles).toHaveLength(1)
  })

  /*
   * A push arrives for every change any surface makes, so a form that took the file each time would
   * pull the port out from under whoever is typing it.
   */
  it('leaves an edited form alone when a later snapshot arrives', () => {
    const edited = after(loaded().state, { input: 'listener-port', value: 47_160 })

    const again = after(edited.state, { input: 'snapshot', value: snapshotOf() })

    expect(again.state.listener.buffer?.port).toBe(47_160)
    expect(RemoteControlSettingsModel.isModified(again.state)).toBe(true)
  })

  it('saves the edited listener and takes the file back once the write landed', () => {
    const edited = after(loaded().state, { input: 'listener-bind-host', value: '127.0.0.1' })

    const saving = after(edited.state, { input: 'save' })
    expect(saving.effects).toEqual([{
      effect: 'save',
      value: { enabled: true, bindHost: '127.0.0.1', port: 47_150, advertisedHost: '10.0.0.2' },
    }])
    // A write in flight is not unsaved work: what it carries is on its way to disk.
    expect(RemoteControlSettingsModel.isModified(saving.state)).toBe(false)

    const saved = after(saving.state, { input: 'saved', ok: true })
    expect(saved.state.listener.loaded?.bindHost).toBe('127.0.0.1')
    expect(saved.state.listener.problem).toBeNull()
  })

  /** A refused bind keeps the edit on screen and says why, in the words this screen owns. */
  it('draws a refused save without dropping what was typed', () => {
    const edited = after(loaded().state, { input: 'listener-port', value: 80 })
    const saving = after(edited.state, { input: 'save' })

    const refused = after(saving.state, {
      input: 'saved',
      ok: false,
      detail: RemoteControlSettingsModel.refusalTextOf({
        code: 'bind-failed',
        detail: 'EACCES 0.0.0.0:80',
      }),
    })

    expect(refused.state.listener.problem)
      .toBe('That address and port could not be bound. (EACCES 0.0.0.0:80)')
    expect(refused.state.listener.buffer?.port).toBe(80)
  })

  /*
   * A section its owner cannot read must not be written over: the next save would replace what is in
   * the file rather than repair it.
   */
  it('refuses every write while the section is damaged', () => {
    const damaged = loaded(snapshotOf({ sectionDamaged: true }))
    expect(RemoteControlSettingsModel.locked(damaged.state)).toBe(true)

    const edited = after(damaged.state, { input: 'listener-port', value: 47_160 })
    expect(edited.state.listener.buffer?.port).toBe(47_150)
    expect(after(damaged.state, { input: 'save' }).effects).toEqual([])
    expect(after(damaged.state, { input: 'copy-bundle' }).effects).toEqual([])
    expect(after(
      damaged.state,
      { input: 'profile-retry', profileId: 'profile-a' },
    ).effects).toEqual([])
    expect(after(damaged.state, {
      input: 'inbound-revoke',
      remoteComputerId: 'computer-b',
      remoteEndpointId: 'endpoint-b',
    }).effects).toEqual([])
  })

  it('runs one command at a time', () => {
    const first = after(loaded().state, { input: 'profile-retry', profileId: 'profile-a' })
    expect(first.effects).toEqual([{ effect: 'profile-retry', profileId: 'profile-a' }])

    const second = after(first.state, { input: 'copy-bundle' })
    expect(second.effects).toEqual([])

    const settled = after(first.state, { input: 'settled', refusal: null })
    expect(settled.state.running).toBeNull()
    expect(settled.state.outcome?.text).toBe('Dialling that computer now.')
    expect(after(settled.state, { input: 'copy-bundle' }).effects)
      .toEqual([{ effect: 'copy-bundle', text: '{"schemaVersion":1}' }])
  })

  it('copies nothing when no bundle has been published', () => {
    const step = after(loaded(snapshotOf({ bundleText: null })).state, { input: 'copy-bundle' })

    expect(step.effects).toEqual([])
    expect(step.state.running).toBeNull()
  })

  /*
   * One field, either form, and no guess here about which of the two it holds: a bundle and an
   * address pin that computer's key at different moments, and the main process is where that is
   * decided.
   */
  it('sends the connect field as it was typed and clears it afterwards', () => {
    const pasted = after(
      loaded().state,
      { input: 'pairing-text', value: '  {"schemaVersion":1}  ' },
    )
    const connecting = after(pasted.state, { input: 'pairing-connect' })
    expect(connecting.effects)
      .toEqual([{ effect: 'pairing-connect', text: '{"schemaVersion":1}' }])
    expect(after(connecting.state, { input: 'settled', refusal: null }).state.pairing)
      .toEqual({ text: '' })

    const typed = after(loaded().state, { input: 'pairing-text', value: ' 10.0.0.2:47150 ' })
    expect(after(typed.state, { input: 'pairing-connect' }).effects)
      .toEqual([{ effect: 'pairing-connect', text: '10.0.0.2:47150' }])
  })

  /** Only the command that ran off the field empties it; a Retry that landed leaves it alone. */
  it('keeps what is typed when some other command settles', () => {
    const typed = after(loaded().state, { input: 'pairing-text', value: '10.0.0.2:47150' })

    const retried = after(
      typed.state,
      { input: 'profile-retry', profileId: 'profile-a' },
      { input: 'settled', refusal: null },
    )

    expect(retried.state.pairing).toEqual({ text: '10.0.0.2:47150' })
  })

  it('asks for something to connect to before it calls the main process with nothing', () => {
    const step = after(loaded().state, { input: 'pairing-connect' })

    expect(step.effects).toEqual([])
    expect(step.state.outcome)
      .toEqual({
        command: { command: 'pairing-connect' },
        text: 'Paste the other computer’s pairing bundle, or type its host:port, first.',
        failed: true,
      })
  })

  /*
   * Revoking is the one inbound removal there is, and it takes both ids: the row names an endpoint
   * and the trust file is keyed by the pair. It arms nothing first - Revoke costs that computer a
   * reconnection, where Forget throws away an endpoint somebody typed.
   */
  it('revokes one allowed-in computer straight away, with both of its ids', () => {
    const step = after(loaded().state, {
      input: 'inbound-revoke',
      remoteComputerId: 'computer-b',
      remoteEndpointId: 'endpoint-b',
    })

    expect(step.effects).toEqual([{
      effect: 'inbound-revoke',
      remoteComputerId: 'computer-b',
      remoteEndpointId: 'endpoint-b',
    }])
    expect(step.state.running).toEqual({ command: 'inbound-revoke', remoteEndpointId: 'endpoint-b' })
    expect(after(step.state, { input: 'settled', refusal: null }).state.outcome?.text)
      .toBe('That computer may no longer reach this one.')
  })

  it('forgets a computer only on the second click', () => {
    const armed = after(loaded().state, { input: 'forget-ask', profileId: 'profile-a' })
    expect(armed.effects).toEqual([])
    expect(armed.state.forgetAsk).toBe('profile-a')

    expect(after(armed.state, { input: 'forget-cancel' }).state.forgetAsk).toBeNull()
    expect(after(RemoteControlSettingsModel
      .transition(armed.state, { input: 'forget-cancel' }).state, { input: 'forget-confirm' })
      .effects).toEqual([])

    const forgetting = after(armed.state, { input: 'forget-confirm' })
    expect(forgetting.effects).toEqual([{ effect: 'profile-forget', profileId: 'profile-a' }])
    expect(after(forgetting.state, { input: 'settled', refusal: null }).state.forgetAsk).toBeNull()
  })

  it('refuses an endpoint whose port is not a port, without calling anything', () => {
    const editing = after(loaded().state, {
      input: 'endpoint-open',
      profileId: 'profile-a',
      endpoint: { host: '203.0.113.10', port: 47_150 },
    })

    const bad = after(
      editing.state,
      { input: 'endpoint-port', value: '70000' },
      { input: 'endpoint-save' },
    )
    expect(bad.effects).toEqual([])
    expect(bad.state.outcome?.failed).toBe(true)
    expect(bad.state.outcome?.text).toContain('between 1 and 65535')

    const empty = after(
      editing.state,
      { input: 'endpoint-host', value: '   ' },
      { input: 'endpoint-save' },
    )
    expect(empty.effects).toEqual([])
    expect(empty.state.outcome?.text).toBe('An endpoint needs a host.')
  })

  it('sends a trimmed endpoint and closes the editor once it landed', () => {
    const editing = after(
      loaded().state,
      { input: 'endpoint-open', profileId: 'profile-a', endpoint: { host: 'old', port: 1 } },
      { input: 'endpoint-host', value: ' 10.0.0.9 ' },
      { input: 'endpoint-port', value: '47160' },
    )

    const saving = after(editing.state, { input: 'endpoint-save' })
    expect(saving.effects).toEqual([{
      effect: 'profile-endpoint',
      profileId: 'profile-a',
      endpoint: { host: '10.0.0.9', port: 47_160 },
    }])

    expect(after(saving.state, { input: 'settled', refusal: null }).state.endpointEdit).toBeNull()
  })

  /*
   * A CLI import can replace a profile while this screen is open, and an armed Forget pointing at a
   * row that is gone would be a click aimed at nothing.
   */
  it('drops an armed Forget and an open editor for a profile that is gone', () => {
    const armed = after(
      loaded().state,
      { input: 'forget-ask', profileId: 'profile-a' },
      { input: 'endpoint-open', profileId: 'profile-a', endpoint: { host: 'a', port: 1 } },
    )

    const without = after(armed.state, { input: 'snapshot', value: snapshotOf({ profiles: [] }) })

    expect(without.state.forgetAsk).toBeNull()
    expect(without.state.endpointEdit).toBeNull()
  })

  it('keeps the reader’s own failure apart from a command being refused', () => {
    const failing = after(loaded().state, { input: 'read-problem', problem: 'it gave up' })
    expect(failing.state.readProblem).toBe('it gave up')
    expect(failing.state.listener.problem).toBeNull()

    expect(after(failing.state, { input: 'read-problem', problem: null }).state.readProblem)
      .toBeNull()
  })

  it('names every listener runtime and refuses one it does not know', () => {
    const runtimes: readonly RemoteListenerRuntime[] = [
      { status: 'disabled' },
      { status: 'starting' },
      { status: 'listening', actualHost: '0.0.0.0', actualPort: 47_150 },
      { status: 'failed', error: 'EADDRINUSE' },
    ]

    expect(runtimes.map((runtime) => RemoteControlSettingsModel.runtimeTextOf(runtime))).toEqual([
      'disabled',
      'starting…',
      'listening on 0.0.0.0:47150',
      'failed: EADDRINUSE',
    ])
    expect(() => RemoteControlSettingsModel
      .runtimeTextOf({ status: 'bound' } as unknown as RemoteListenerRuntime))
      .toThrow(/Unknown remote listener runtime/)
  })

  it('names every outbound status and refuses one it does not know', () => {
    expect((['connected', 'connecting', 'offline', 'idle'] as const)
      .map((status) => RemoteControlSettingsModel.statusTextOf(status)))
      .toEqual(['connected', 'connecting…', 'offline', 'idle, nothing is asking for it'])
    expect(() => RemoteControlSettingsModel
      .statusTextOf('dialling' as unknown as RemoteSettingsProfileDto['status']))
      .toThrow(/Unknown remote outbound status/)
  })

  /** A tenth refusal has to be given a sentence here before anybody is shown the bare word. */
  it('gives every refusal code a sentence and refuses one it does not know', () => {
    const codes: readonly RemoteSettingsRefusalCode[] = [
      'busy', 'stopping', 'bind-failed', 'config-refused',
      'invalid-bundle', 'identity-conflict', 'not-confirmed', 'not-found', 'probe-failed',
    ]

    const sentences = codes
      .map((code) => RemoteControlSettingsModel.refusalTextOf({ code, detail: 'why' }))

    for (const sentence of sentences)
      expect(sentence).toMatch(/[.] \(why\)$/)
    // One code answered with another's sentence would read as a refusal that never happened.
    expect(new Set(sentences).size).toBe(codes.length)
    expect(() => RemoteControlSettingsModel.refusalTextOf({
      code: 'exploded' as RemoteSettingsRefusalCode,
      detail: 'why',
    })).toThrow(/Unknown remote settings refusal/)
  })

  it('refuses an input it does not know', () => {
    expect(() => RemoteControlSettingsModel.transition(
      RemoteControlSettingsModel.initial().state,
      { input: 'detonate' } as unknown as RemoteControlSettingsInput,
    )).toThrow(/Unknown remote control settings input/)
  })
})
