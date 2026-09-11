import { describe, expect, it } from 'vitest'

import type { RemarkableDependencyStatus } from '../../../../../shared/remarkableApi.types'
import type { RemarkableSettingsValue } from '../../../../../shared/remarkableSettings'
import {
  RemarkableSettingsModel,
  type RemarkableSettingsModelState,
} from './remarkableSettingsModel'

describe('app-client-ui/renderer/overlays/configuration/tabs/remarkable/remarkableSettingsModel', () => {
  const fingerprintConst = `SHA256:${'A'.repeat(43)}`
  const candidateConst = `SHA256:${'B'.repeat(43)}`
  const storedConst: RemarkableSettingsValue = {
    host: '10.0.0.25',
    fingerprint: fingerprintConst,
    timeoutMilliseconds: 180_000,
  }
  const readyConst: RemarkableDependencyStatus = {
    kind: 'ready',
    bundleId: 'bundle-1',
    nodeVersion: '22.23.2',
    cliVersion: '1.4.0',
  }

  function loaded(
    value: RemarkableSettingsValue = storedConst,
    passwordConfigured = true,
  ): RemarkableSettingsModelState {
    return RemarkableSettingsModel.transition(RemarkableSettingsModel.initial().state, {
      input: 'loaded',
      value,
      passwordConfigured,
    }).state
  }

  it('loads settings and dependency status independently on mount', () => {
    const start = RemarkableSettingsModel.initial()

    expect(start.state.persisted).toEqual({
      loaded: null,
      buffer: null,
      saving: null,
      problem: null,
    })
    expect(start.state.dependencies).toBeNull()
    expect(start.state.passwordDraft).toBe('')
    expect(start.effects).toEqual([{ effect: 'load' }, { effect: 'dependencies-status' }])
    expect(RemarkableSettingsModel.isModified(start.state)).toBe(false)
  })

  it('loads the secret only as host-bound configured state', () => {
    const state = loaded()

    expect(state.persisted.buffer).toEqual(storedConst)
    expect(state.passwordConfiguredForHost).toBe('10.0.0.25')
    expect(RemarkableSettingsModel.passwordConfigured(state)).toBe(true)
    expect(JSON.stringify(state)).not.toContain('password"')
  })

  it('keeps every dependency status variant as the main process answered it', () => {
    const statuses: RemarkableDependencyStatus[] = [
      readyConst,
      { kind: 'missing', detail: 'not installed' },
      { kind: 'outdated', detail: 'old bundle' },
      { kind: 'damaged', detail: 'hash mismatch' },
      { kind: 'source-missing', detail: 'resource absent' },
      { kind: 'unsupported-platform', detail: 'linux arm64' },
    ]

    for (const status of statuses) {
      const result = RemarkableSettingsModel.transition(loaded(), {
        input: 'dependencies-loaded',
        status,
      }).state
      expect(result.dependencies).toEqual(status)
    }
  })

  /**
   * The order is the product here, not decoration: dependencies, host, password, fingerprint, test.
   * Nothing above may claim to be ready while something below it is still missing.
   */
  it('walks the setup in one order and names the first thing each step waits for', () => {
    const blockers = (state: RemarkableSettingsModelState) =>
      Object.fromEntries(RemarkableSettingsModel.setupSteps(state)
        .map((step) => [step.id, step.blockedBy]))

    const nothing = RemarkableSettingsModel.initial().state
    expect(RemarkableSettingsModel.setupSteps(nothing).map((step) => step.id)).toEqual([
      'dependencies', 'host', 'password', 'fingerprint', 'connection',
    ])
    expect(RemarkableSettingsModel.setupSteps(nothing).map((step) => step.position))
      .toEqual([1, 2, 3, 4, 5])
    expect(blockers(nothing)).toEqual({
      dependencies: null,
      host: null,
      password: 'host-missing',
      fingerprint: 'dependencies-missing',
      connection: 'dependencies-missing',
    })

    const installed = RemarkableSettingsModel.transition(nothing, {
      input: 'dependencies-loaded', status: readyConst,
    }).state
    expect(blockers(installed)).toMatchObject({
      password: 'host-missing', fingerprint: 'host-missing', connection: 'host-missing',
    })

    const hosted = RemarkableSettingsModel.transition(installed, {
      input: 'loaded', value: { host: '10.0.0.25', timeoutMilliseconds: 180_000 },
      passwordConfigured: false,
    }).state
    expect(blockers(hosted)).toMatchObject({
      password: null, fingerprint: 'password-missing', connection: 'password-missing',
    })

    const setting = RemarkableSettingsModel.transition(
      RemarkableSettingsModel.transition(hosted, {
        input: 'password-draft', value: 'secret',
      }).state,
      { input: 'set-password' },
    ).state
    const withPassword = RemarkableSettingsModel.transition(setting, {
      input: 'password-settled', storedHost: '10.0.0.25', result: { ok: true, value: undefined },
    }).state
    expect(blockers(withPassword)).toMatchObject({
      fingerprint: null, connection: 'fingerprint-missing',
    })

    const pinned = RemarkableSettingsModel.transition(withPassword, {
      input: 'loaded', value: storedConst, passwordConfigured: true,
    }).state
    expect(blockers(pinned)).toMatchObject({ fingerprint: null, connection: null })
    expect(RemarkableSettingsModel.setupSteps(pinned).map((step) => step.done))
      .toEqual([true, true, true, true, false])
  })

  it('makes an edited host block everything stored against the saved one', () => {
    const state = RemarkableSettingsModel.transition(
      RemarkableSettingsModel.transition(loaded(), {
        input: 'dependencies-loaded', status: readyConst,
      }).state,
      { input: 'host', value: '10.0.0.26' },
    ).state

    const blocked = RemarkableSettingsModel.setupSteps(state)
      .filter((step) => step.blockedBy === 'host-unsaved')
      .map((step) => step.id)
    expect(blocked).toEqual(['password', 'fingerprint', 'connection'])
  })

  it('marks only persisted connection fields as dirty', () => {
    const password = RemarkableSettingsModel.transition(loaded(), {
      input: 'password-draft',
      value: 'temporary-secret',
    }).state
    const dependency = RemarkableSettingsModel.transition(password, {
      input: 'dependencies-loaded',
      status: readyConst,
    }).state
    const installing = RemarkableSettingsModel.transition(dependency, {
      input: 'install-dependencies',
    }).state

    expect(RemarkableSettingsModel.isModified(password)).toBe(false)
    expect(RemarkableSettingsModel.isModified(dependency)).toBe(false)
    expect(RemarkableSettingsModel.isModified(installing)).toBe(false)

    const timed = RemarkableSettingsModel.transition(loaded(), {
      input: 'timeout',
      value: 120_000,
    }).state
    expect(RemarkableSettingsModel.isModified(timed)).toBe(true)
  })

  it('clears the fingerprint and candidate whenever the host is edited', () => {
    const detecting = RemarkableSettingsModel.transition(loaded(), {
      input: 'detect-fingerprint',
    }).state
    const detected = RemarkableSettingsModel.transition(detecting, {
      input: 'fingerprint-detected',
      expectedHost: '10.0.0.25',
      result: {
        ok: true,
        value: { host: '10.0.0.25', fingerprint: candidateConst },
      },
    }).state

    const edited = RemarkableSettingsModel.transition(detected, {
      input: 'host',
      value: '10.0.0.26',
    }).state

    expect(edited.persisted.buffer).toEqual({
      host: '10.0.0.26',
      timeoutMilliseconds: 180_000,
    })
    expect(edited.fingerprintCandidate).toBeNull()
    expect(RemarkableSettingsModel.isModified(edited)).toBe(true)
  })

  it('does not change config until a detected fingerprint is explicitly confirmed', () => {
    const detecting = RemarkableSettingsModel.transition(loaded(), {
      input: 'detect-fingerprint',
    })
    expect(detecting.effects).toEqual([{
      effect: 'fingerprint-detect',
      expectedHost: '10.0.0.25',
    }])
    const detected = RemarkableSettingsModel.transition(detecting.state, {
      input: 'fingerprint-detected',
      expectedHost: '10.0.0.25',
      result: {
        ok: true,
        value: { host: '10.0.0.25', fingerprint: candidateConst },
      },
    }).state

    expect(detected.persisted.buffer?.fingerprint).toBe(fingerprintConst)
    expect(RemarkableSettingsModel.isModified(detected)).toBe(false)

    // Using the candidate IS the explicit confirmation, so it pins and writes in one act rather
    // than leaving a pinned-looking value waiting for a Save in another part of the card.
    const confirmed = RemarkableSettingsModel.transition(detected, {
      input: 'confirm-fingerprint',
    })
    expect(confirmed.state.persisted.buffer?.fingerprint).toBe(candidateConst)
    expect(confirmed.state.fingerprintCandidate).toBeNull()
    expect(confirmed.effects).toEqual([{
      effect: 'save',
      value: { ...storedConst, fingerprint: candidateConst },
    }])

    const written = RemarkableSettingsModel.transition(confirmed.state, {
      input: 'saved', ok: true,
    }).state
    expect(written.persisted.loaded?.fingerprint).toBe(candidateConst)
    expect(RemarkableSettingsModel.isModified(written)).toBe(false)
  })

  it('refuses to pin while another edit is unsaved, so one click writes one thing', () => {
    const detected = RemarkableSettingsModel.transition(
      RemarkableSettingsModel.transition(loaded(), { input: 'detect-fingerprint' }).state,
      {
        input: 'fingerprint-detected',
        expectedHost: '10.0.0.25',
        result: { ok: true, value: { host: '10.0.0.25', fingerprint: candidateConst } },
      },
    ).state
    const edited = RemarkableSettingsModel.transition(detected, {
      input: 'timeout', value: 120_000,
    }).state

    const confirmed = RemarkableSettingsModel.transition(edited, { input: 'confirm-fingerprint' })
    expect(confirmed.effects).toEqual([])
    expect(confirmed.state.persisted.buffer?.fingerprint).toBe(fingerprintConst)
    expect(confirmed.state.fingerprintCandidate).not.toBeNull()
  })

  it('ignores a fingerprint result after its host was edited', () => {
    const detecting = RemarkableSettingsModel.transition(loaded(), {
      input: 'detect-fingerprint',
    }).state
    const edited = RemarkableSettingsModel.transition(detecting, {
      input: 'host',
      value: '10.0.0.26',
    }).state
    const late = RemarkableSettingsModel.transition(edited, {
      input: 'fingerprint-detected',
      expectedHost: '10.0.0.25',
      result: {
        ok: true,
        value: { host: '10.0.0.25', fingerprint: candidateConst },
      },
    }).state

    expect(late.fingerprintCandidate).toBeNull()
    expect(late.persisted.buffer?.host).toBe('10.0.0.26')
    expect(late.running).toBeNull()
  })

  it('preserves unknown config keys through edits, reset and save', () => {
    const withFuture = {
      ...storedConst,
      futurePolicy: { note: 'keep me' },
    } as unknown as RemarkableSettingsValue
    const reset = RemarkableSettingsModel.transition(loaded(withFuture), { input: 'reset' }).state

    expect(reset.persisted.buffer).toEqual({
      timeoutMilliseconds: 180_000,
      futurePolicy: { note: 'keep me' },
    })

    const edited = RemarkableSettingsModel.transition(reset, {
      input: 'host',
      value: '10.0.0.30',
    }).state
    const saving = RemarkableSettingsModel.transition(edited, { input: 'save' })
    expect(saving.effects).toEqual([{ effect: 'save', value: edited.persisted.buffer }])
    expect((saving.effects[0] as unknown as { value: Record<string, unknown> }).value.futurePolicy)
      .toEqual({ note: 'keep me' })
  })

  it('keeps immediate state when reset changes only the persisted buffer', () => {
    const withStatus = RemarkableSettingsModel.transition(loaded(), {
      input: 'dependencies-loaded',
      status: readyConst,
    }).state
    const reset = RemarkableSettingsModel.transition(withStatus, { input: 'reset' }).state

    expect(reset.dependencies).toEqual(readyConst)
    expect(reset.passwordConfiguredForHost).toBe('10.0.0.25')
    expect(reset.persisted.buffer).toEqual({ timeoutMilliseconds: 180_000 })
  })

  it('sends a password once and removes it from all settled state and errors', () => {
    const drafted = RemarkableSettingsModel.transition(loaded(), {
      input: 'password-draft',
      value: 'private-value',
    }).state
    const started = RemarkableSettingsModel.transition(drafted, { input: 'set-password' })

    expect(started.effects).toEqual([{
      effect: 'password-set',
      storedHost: '10.0.0.25',
      password: 'private-value',
    }])
    expect(started.state.passwordDraft).toBe('')

    const failed = RemarkableSettingsModel.transition(started.state, {
      input: 'password-settled',
      storedHost: '10.0.0.25',
      result: { ok: false, code: 'credential-unavailable', detail: 'encryption unavailable' },
    }).state
    expect(failed.passwordDraft).toBe('')
    expect(failed.actionProblem).toEqual({
      action: 'set-password',
      code: 'credential-unavailable',
      detail: 'encryption unavailable',
    })
    expect(JSON.stringify(failed)).not.toContain('private-value')
  })

  it('clears a password draft on every clear-password result too', () => {
    const drafted = RemarkableSettingsModel.transition(loaded(), {
      input: 'password-draft',
      value: 'replace-later',
    }).state
    const clearing = RemarkableSettingsModel.transition(drafted, { input: 'clear-password' })

    expect(clearing.state.passwordDraft).toBe('')
    expect(clearing.effects).toEqual([{
      effect: 'password-clear',
      storedHost: '10.0.0.25',
    }])

    const refused = RemarkableSettingsModel.transition(clearing.state, {
      input: 'password-cleared',
      result: { ok: false, code: 'credential-unavailable', detail: 'encryption unavailable' },
    }).state
    expect(refused.passwordDraft).toBe('')
    expect(RemarkableSettingsModel.passwordConfigured(refused)).toBe(true)
  })

  it('allows only one immediate action at a time without consuming a later password draft', () => {
    const installing = RemarkableSettingsModel.transition(loaded(), {
      input: 'install-dependencies',
    }).state
    const drafted = RemarkableSettingsModel.transition(installing, {
      input: 'password-draft',
      value: 'wait-for-install',
    }).state
    const refused = RemarkableSettingsModel.transition(drafted, { input: 'set-password' })

    expect(refused.effects).toEqual([])
    expect(refused.state.running).toBe('install-dependencies')
    expect(refused.state.passwordDraft).toBe('wait-for-install')
  })

  it('updates dependency status on install and preserves config on install failure', () => {
    const dirty = RemarkableSettingsModel.transition(loaded(), {
      input: 'timeout',
      value: 90_000,
    }).state
    const installing = RemarkableSettingsModel.transition(dirty, {
      input: 'install-dependencies',
    }).state
    const failed = RemarkableSettingsModel.transition(installing, {
      input: 'dependencies-installed',
      result: { ok: false, code: 'install-failed', detail: 'copy refused' },
    }).state

    expect(failed.persisted.buffer?.timeoutMilliseconds).toBe(90_000)
    expect(RemarkableSettingsModel.isModified(failed)).toBe(true)
    expect(failed.actionProblem?.code).toBe('install-failed')

    const retry = RemarkableSettingsModel.transition(failed, {
      input: 'install-dependencies',
    }).state
    const installed = RemarkableSettingsModel.transition(retry, {
      input: 'dependencies-installed',
      result: { ok: true, value: readyConst },
    }).state
    expect(installed.dependencies).toEqual(readyConst)
  })

  it('stores a connection refusal separately without losing the buffer', () => {
    const ready = RemarkableSettingsModel.transition(loaded(), {
      input: 'dependencies-loaded',
      status: readyConst,
    }).state
    const testing = RemarkableSettingsModel.transition(ready, { input: 'test-connection' }).state
    const failed = RemarkableSettingsModel.transition(testing, {
      input: 'connection-tested',
      result: { ok: false, code: 'device-unreachable', detail: 'wake it' },
    }).state

    expect(failed.connectionTest).toEqual({
      ok: false,
      code: 'device-unreachable',
      detail: 'wake it',
    })
    expect(failed.persisted.buffer).toEqual(storedConst)
    expect(failed.actionProblem).toBeNull()
  })

  it('invalidates a successful connection result before setting or clearing credentials', () => {
    const ready = RemarkableSettingsModel.transition(loaded(), {
      input: 'dependencies-loaded',
      status: readyConst,
    }).state
    const testing = RemarkableSettingsModel.transition(ready, { input: 'test-connection' }).state
    const tested = RemarkableSettingsModel.transition(testing, {
      input: 'connection-tested',
      result: { ok: true, value: undefined },
    }).state
    const drafted = RemarkableSettingsModel.transition(tested, {
      input: 'password-draft',
      value: 'replacement',
    }).state

    expect(RemarkableSettingsModel.transition(drafted, { input: 'set-password' }).state.connectionTest)
      .toBeNull()
    expect(RemarkableSettingsModel.transition(tested, { input: 'clear-password' }).state.connectionTest)
      .toBeNull()
  })

  it('does not reuse a password after saving another host', () => {
    const changed = RemarkableSettingsModel.transition(loaded(), {
      input: 'host',
      value: '10.0.0.31',
    }).state
    const saving = RemarkableSettingsModel.transition(changed, { input: 'save' }).state
    const saved = RemarkableSettingsModel.transition(saving, { input: 'saved', ok: true }).state

    expect(saved.passwordConfiguredForHost).toBe('10.0.0.25')
    expect(RemarkableSettingsModel.passwordConfigured(saved)).toBe(false)
  })

  it('names only an unknown discriminant and never serializes a password beside it', () => {
    expect(() => RemarkableSettingsModel.transition(loaded(), {
      input: 'unknown',
      password: 'must-not-leak',
    } as never)).toThrow('Unknown reMarkable settings input: unknown')
    try {
      RemarkableSettingsModel.transition(loaded(), {
        input: 'unknown',
        password: 'must-not-leak',
      } as never)
    }
    catch (error) {
      expect(String(error)).not.toContain('must-not-leak')
    }
  })
})
