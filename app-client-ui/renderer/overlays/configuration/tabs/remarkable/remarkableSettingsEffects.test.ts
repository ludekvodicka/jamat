import { afterEach, describe, expect, it } from 'vitest'

import type {
  RemarkableDependencyStatus,
  RemarkableSettingsSnapshot,
} from '../../../../../shared/remarkableApi.types'
import type { AppClientUiBridge } from '../../../../../shared/appClientUiIpc'
import type { RemarkableSettingsValue } from '../../../../../shared/remarkableSettings'
import {
  RemarkableSettingsEffects,
  type RemarkableSettingsPorts,
} from './remarkableSettingsEffects'
import type {
  RemarkableSettingsEffect,
  RemarkableSettingsInput,
} from './remarkableSettingsModel'

describe('app-client-ui/renderer/overlays/configuration/tabs/remarkable/remarkableSettingsEffects', () => {
  const fingerprintConst = `SHA256:${'A'.repeat(43)}`
  const settingsConst: RemarkableSettingsSnapshot = {
    value: {
      host: '10.0.0.25',
      fingerprint: fingerprintConst,
      timeoutMilliseconds: 180_000,
    },
    passwordConfigured: true,
  }
  const readyConst: RemarkableDependencyStatus = {
    kind: 'ready',
    bundleId: 'bundle-1',
    nodeVersion: '22.23.2',
    cliVersion: '1.4.0',
  }

  class BridgeStub {
    readonly calls: string[] = []
    readonly saved: RemarkableSettingsValue[] = []
    readonly passwords: { host: string; password: string }[] = []
    readonly clearedHosts: string[] = []
    rejectedMethod: string | null = null
    getAnswer: unknown = { ok: true, value: settingsConst }
    saveAnswer: unknown = { ok: true, value: { ok: true, value: undefined } }
    statusAnswer: unknown = { ok: true, value: readyConst }
    installAnswer: unknown = { ok: true, value: { ok: true, value: readyConst } }
    detectAnswer: unknown = {
      ok: true,
      value: {
        ok: true,
        value: { host: '10.0.0.25', fingerprint: fingerprintConst },
      },
    }
    setAnswer: unknown = { ok: true, value: { ok: true, value: undefined } }
    clearAnswer: unknown = { ok: true, value: { ok: true, value: undefined } }
    testAnswer: unknown = { ok: true, value: { ok: true, value: undefined } }

    install(): void {
      const bridge = {
        remarkable: {
          getSettings: () => {
            this.calls.push('getSettings')
            return this.response('getSettings', this.getAnswer)
          },
          saveSettings: (value: RemarkableSettingsValue) => {
            this.calls.push('saveSettings')
            this.saved.push(value)
            return this.response('saveSettings', this.saveAnswer)
          },
          dependenciesStatus: () => {
            this.calls.push('dependenciesStatus')
            return this.response('dependenciesStatus', this.statusAnswer)
          },
          installDependencies: () => {
            this.calls.push('installDependencies')
            return this.response('installDependencies', this.installAnswer)
          },
          detectFingerprint: () => {
            this.calls.push('detectFingerprint')
            return this.response('detectFingerprint', this.detectAnswer)
          },
          setPassword: (host: string, password: string) => {
            this.calls.push('setPassword')
            this.passwords.push({ host, password })
            return this.response('setPassword', this.setAnswer, password)
          },
          clearPassword: (host: string) => {
            this.calls.push('clearPassword')
            this.clearedHosts.push(host)
            return this.response('clearPassword', this.clearAnswer)
          },
          testConnection: () => {
            this.calls.push('testConnection')
            return this.response('testConnection', this.testAnswer)
          },
        },
      }
      ;(window as unknown as { appClient: unknown }).appClient = bridge as unknown as
        Pick<AppClientUiBridge, 'remarkable'>
    }

    private response(method: string, value: unknown, detail = 'bridge rejected'): Promise<unknown> {
      return this.rejectedMethod === method
        ? Promise.reject(new Error(detail))
        : Promise.resolve(value)
    }
  }

  function recorder(): { ports: RemarkableSettingsPorts; inputs: RemarkableSettingsInput[] } {
    const inputs: RemarkableSettingsInput[] = []
    return { ports: { dispatch: (input) => inputs.push(input) }, inputs }
  }

  async function run(
    effect: RemarkableSettingsEffect,
    stub = new BridgeStub(),
  ): Promise<{ inputs: RemarkableSettingsInput[]; stub: BridgeStub }> {
    stub.install()
    const { ports, inputs } = recorder()
    await RemarkableSettingsEffects.run(effect, ports)
    return { inputs, stub }
  }

  afterEach(() => {
    delete (window as unknown as { appClient?: unknown }).appClient
  })

  it('loads the settings snapshot without asking for a password value', async () => {
    const { inputs, stub } = await run({ effect: 'load' })

    expect(stub.calls).toEqual(['getSettings'])
    expect(inputs).toEqual([{
      input: 'loaded',
      value: settingsConst.value,
      passwordConfigured: true,
    }])
    expect(JSON.stringify(inputs)).not.toContain('private')
  })

  it('saves the exact settings buffer including unknown fields', async () => {
    const value = {
      ...settingsConst.value,
      futureSetting: 'kept',
    } as unknown as RemarkableSettingsValue
    const { inputs, stub } = await run({ effect: 'save', value })

    expect(stub.calls).toEqual(['saveSettings'])
    expect(stub.saved).toEqual([value])
    expect(inputs).toEqual([{ input: 'saved', ok: true, detail: undefined }])
  })

  it('loads dependency status and installs through separate exact methods', async () => {
    const status = await run({ effect: 'dependencies-status' })
    expect(status.stub.calls).toEqual(['dependenciesStatus'])
    expect(status.inputs).toEqual([{ input: 'dependencies-loaded', status: readyConst }])

    const install = await run({ effect: 'dependencies-install' })
    expect(install.stub.calls).toEqual(['installDependencies'])
    expect(install.inputs).toEqual([{
      input: 'dependencies-installed',
      result: { ok: true, value: readyConst },
    }])
  })

  it('detects against main stored settings and carries only the expected host locally', async () => {
    const { inputs, stub } = await run({
      effect: 'fingerprint-detect',
      expectedHost: '10.0.0.25',
    })

    expect(stub.calls).toEqual(['detectFingerprint'])
    expect(inputs).toEqual([{
      input: 'fingerprint-detected',
      expectedHost: '10.0.0.25',
      result: {
        ok: true,
        value: { host: '10.0.0.25', fingerprint: fingerprintConst },
      },
    }])
  })

  it('sends a password only as the write-only method argument', async () => {
    const { inputs, stub } = await run({
      effect: 'password-set',
      storedHost: '10.0.0.25',
      password: 'private-value',
    })

    expect(stub.calls).toEqual(['setPassword'])
    expect(stub.passwords).toEqual([{
      host: '10.0.0.25',
      password: 'private-value',
    }])
    expect(inputs).toEqual([{
      input: 'password-settled',
      storedHost: '10.0.0.25',
      result: { ok: true, value: undefined },
    }])
    expect(JSON.stringify(inputs)).not.toContain('private-value')
  })

  it('does not dispatch even a broken main-process detail that echoes the password', async () => {
    const stub = new BridgeStub()
    stub.setAnswer = {
      ok: true,
      value: {
        ok: false,
        code: 'credential-unavailable',
        detail: 'could not encrypt private-value',
        retryable: false,
      },
    }

    const { inputs } = await run({
      effect: 'password-set',
      storedHost: '10.0.0.25',
      password: 'private-value',
    }, stub)

    expect(inputs).toEqual([{
      input: 'password-settled',
      storedHost: '10.0.0.25',
      result: {
        ok: false,
        code: 'credential-unavailable',
        detail: 'The password update failed; its unsafe error detail was hidden',
      },
    }])
    expect(JSON.stringify(inputs)).not.toContain('private-value')
  })

  it('clears password and tests connection with no renderer settings arguments', async () => {
    const clear = await run({ effect: 'password-clear', storedHost: '10.0.0.25' })
    expect(clear.stub.calls).toEqual(['clearPassword'])
    expect(clear.stub.clearedHosts).toEqual(['10.0.0.25'])
    expect(clear.inputs).toEqual([{
      input: 'password-cleared',
      result: { ok: true, value: undefined },
    }])

    const test = await run({ effect: 'connection-test' })
    expect(test.stub.calls).toEqual(['testConnection'])
    expect(test.inputs).toEqual([{
      input: 'connection-tested',
      result: { ok: true, value: undefined },
    }])
  })

  it('keeps transport failures distinct from typed domain refusals', async () => {
    const transportStub = new BridgeStub()
    transportStub.testAnswer = { ok: false, error: 'renderer is gone' }
    const transport = await run({ effect: 'connection-test' }, transportStub)
    expect(transport.inputs).toEqual([{
      input: 'connection-tested',
      result: {
        ok: false,
        code: 'transport',
        detail: 'The main process did not answer: renderer is gone',
      },
    }])

    const refusalStub = new BridgeStub()
    refusalStub.installAnswer = {
      ok: true,
      value: {
        ok: false,
        code: 'install-failed',
        detail: 'copy refused',
        retryable: false,
      },
    }
    const refusal = await run({ effect: 'dependencies-install' }, refusalStub)
    expect(refusal.inputs).toEqual([{
      input: 'dependencies-installed',
      result: { ok: false, code: 'install-failed', detail: 'copy refused' },
    }])
  })

  it('reports a dependency status channel failure without inventing a status', async () => {
    const stub = new BridgeStub()
    stub.statusAnswer = { ok: false, error: 'main process is gone' }

    const { inputs } = await run({ effect: 'dependencies-status' }, stub)

    expect(inputs).toEqual([{
      input: 'dependencies-status-failed',
      detail: 'The main process did not answer: main process is gone',
    }])
  })

  it('settles every loading or running state when a bridge promise rejects', async () => {
    const detail = 'The main process call failed before returning a result'
    const failure = { ok: false as const, code: 'transport' as const, detail }
    const cases: [string, RemarkableSettingsEffect, RemarkableSettingsInput][] = [
      ['getSettings', { effect: 'load' }, { input: 'failed', detail }],
      ['saveSettings', { effect: 'save', value: settingsConst.value }, { input: 'failed', detail }],
      [
        'dependenciesStatus',
        { effect: 'dependencies-status' },
        { input: 'dependencies-status-failed', detail },
      ],
      [
        'installDependencies',
        { effect: 'dependencies-install' },
        { input: 'dependencies-installed', result: failure },
      ],
      [
        'detectFingerprint',
        { effect: 'fingerprint-detect', expectedHost: '10.0.0.25' },
        {
          input: 'fingerprint-detected',
          expectedHost: '10.0.0.25',
          result: failure,
        },
      ],
      [
        'setPassword',
        { effect: 'password-set', storedHost: '10.0.0.25', password: 'private-value' },
        { input: 'password-settled', storedHost: '10.0.0.25', result: failure },
      ],
      [
        'clearPassword',
        { effect: 'password-clear', storedHost: '10.0.0.25' },
        { input: 'password-cleared', result: failure },
      ],
      [
        'testConnection',
        { effect: 'connection-test' },
        { input: 'connection-tested', result: failure },
      ],
    ]

    for (const [method, effect, expected] of cases) {
      const stub = new BridgeStub()
      stub.rejectedMethod = method
      const { inputs } = await run(effect, stub)
      expect(inputs, method).toEqual([expected])
      expect(JSON.stringify(inputs), method).not.toContain('private-value')
    }
  })

  it('names only an unknown effect discriminant and does not serialize adjacent secret data', async () => {
    const effect = { effect: 'unknown', password: 'must-not-leak' } as unknown as RemarkableSettingsEffect
    await expect(RemarkableSettingsEffects.run(effect, recorder().ports))
      .rejects.toThrow('Unknown reMarkable settings effect: unknown')
    try {
      await RemarkableSettingsEffects.run(effect, recorder().ports)
    }
    catch (error) {
      expect(String(error)).not.toContain('must-not-leak')
    }
  })
})
