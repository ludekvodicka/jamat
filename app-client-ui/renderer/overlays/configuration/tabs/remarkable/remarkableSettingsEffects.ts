import type {
  RemarkableResult,
  RemarkableSettingsSnapshot,
} from '../../../../../shared/remarkableApi.types'
import type { IpcResult } from '../../../../../shared/appClientUiIpc'
import type { RemarkableSettingsValue } from '../../../../../shared/remarkableSettings'
import {
  SettingsCardEffects,
  type SettingsCardPorts,
} from '../../settingsCard'
import type {
  RemarkableSettingsActionResult,
  RemarkableSettingsEffect,
  RemarkableSettingsInput,
} from './remarkableSettingsModel'

export type RemarkableSettingsPorts = SettingsCardPorts<RemarkableSettingsInput>

export class RemarkableSettingsEffects {
  static async run(
    effect: RemarkableSettingsEffect,
    ports: RemarkableSettingsPorts,
  ): Promise<void> {
    try {
      if (effect.effect === 'load')
        return await SettingsCardEffects.load(
        () => window.appClient.remarkable.getSettings(),
        ports,
        {
          loaded: (snapshot: RemarkableSettingsSnapshot) => ({
            input: 'loaded' as const,
            value: snapshot.value,
            passwordConfigured: snapshot.passwordConfigured,
          }),
          failed: (detail: string) => ({ input: 'failed' as const, detail }),
        },
      )
      else if (effect.effect === 'save')
        return await SettingsCardEffects.save(
        effect.value,
        (value: RemarkableSettingsValue) => window.appClient.remarkable.saveSettings(value),
        ports,
        {
          failed: (detail: string) => ({ input: 'failed' as const, detail }),
          saved: (ok: boolean, detail?: string) => ({
            input: 'saved' as const,
            ok,
            detail,
          }),
        },
      )
      else if (effect.effect === 'dependencies-status') {
        const answer = await window.appClient.remarkable.dependenciesStatus()
        if (!answer.ok)
          return ports.dispatch({
            input: 'dependencies-status-failed',
            detail: RemarkableSettingsEffects.transportDetail(answer.error),
          })
        return ports.dispatch({ input: 'dependencies-loaded', status: answer.value })
      }
      else if (effect.effect === 'dependencies-install')
        return ports.dispatch({
          input: 'dependencies-installed',
          result: await RemarkableSettingsEffects.result(
            window.appClient.remarkable.installDependencies(),
          ),
        })
      else if (effect.effect === 'fingerprint-detect')
        return ports.dispatch({
          input: 'fingerprint-detected',
          expectedHost: effect.expectedHost,
          result: await RemarkableSettingsEffects.result(
            window.appClient.remarkable.detectFingerprint(),
          ),
        })
      else if (effect.effect === 'password-set')
        return ports.dispatch({
          input: 'password-settled',
          storedHost: effect.storedHost,
          result: RemarkableSettingsEffects.withoutPassword(
            await RemarkableSettingsEffects.result(
              window.appClient.remarkable.setPassword(effect.storedHost, effect.password),
            ),
            effect.password,
          ),
        })
      else if (effect.effect === 'password-clear')
        return ports.dispatch({
          input: 'password-cleared',
          result: await RemarkableSettingsEffects.result(
            window.appClient.remarkable.clearPassword(effect.storedHost),
          ),
        })
      else if (effect.effect === 'connection-test')
        return ports.dispatch({
          input: 'connection-tested',
          result: await RemarkableSettingsEffects.result(
            window.appClient.remarkable.testConnection(),
          ),
        })
      else
        throw new Error(
          `Unknown reMarkable settings effect: ${String((effect as { effect?: unknown }).effect)}`,
        )
    } catch {
      return RemarkableSettingsEffects.rejected(effect, ports)
    }
  }

  private static rejected(
    effect: RemarkableSettingsEffect,
    ports: RemarkableSettingsPorts,
  ): void {
    const detail = 'The main process call failed before returning a result'
    const result: RemarkableSettingsActionResult = { ok: false, code: 'transport', detail }
    if (effect.effect === 'load' || effect.effect === 'save')
      ports.dispatch({ input: 'failed', detail })
    else if (effect.effect === 'dependencies-status')
      ports.dispatch({ input: 'dependencies-status-failed', detail })
    else if (effect.effect === 'dependencies-install')
      ports.dispatch({ input: 'dependencies-installed', result })
    else if (effect.effect === 'fingerprint-detect')
      ports.dispatch({ input: 'fingerprint-detected', expectedHost: effect.expectedHost, result })
    else if (effect.effect === 'password-set')
      ports.dispatch({ input: 'password-settled', storedHost: effect.storedHost, result })
    else if (effect.effect === 'password-clear')
      ports.dispatch({ input: 'password-cleared', result })
    else if (effect.effect === 'connection-test')
      ports.dispatch({ input: 'connection-tested', result })
    else throw new Error(
      `Unknown reMarkable settings effect: ${String((effect as { effect?: unknown }).effect)}`,
    )
  }

  private static async result<TValue>(
    call: Promise<IpcResult<RemarkableResult<TValue>>>,
  ): Promise<RemarkableSettingsActionResult<TValue>> {
    const answer = await call
    if (!answer.ok)
      return {
        ok: false,
        code: 'transport',
        detail: RemarkableSettingsEffects.transportDetail(answer.error),
      }
    if (answer.value.ok) return answer.value
    return {
      ok: false,
      code: answer.value.code,
      detail: answer.value.detail,
    }
  }

  private static transportDetail(error: string): string {
    return `The main process did not answer: ${error}`
  }

  private static withoutPassword<TValue>(
    result: RemarkableSettingsActionResult<TValue>,
    password: string,
  ): RemarkableSettingsActionResult<TValue> {
    if (result.ok || password.length === 0 || !result.detail.includes(password)) return result
    return {
      ...result,
      detail: 'The password update failed; its unsafe error detail was hidden',
    }
  }
}
