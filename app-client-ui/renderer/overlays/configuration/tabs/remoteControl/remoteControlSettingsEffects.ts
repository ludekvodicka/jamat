import type { IpcResult } from '../../../../../shared/appClientUiIpc'
import type { RemoteSettingsSaveResult } from '../../../../../shared/remoteSettingsSnapshot'
import type { SettingsCardPorts } from '../../settingsCard'
import {
  RemoteControlSettingsModel,
  type RemoteControlSettingsEffect,
  type RemoteControlSettingsInput,
} from './remoteControlSettingsModel'

export type RemoteControlSettingsPorts = SettingsCardPorts<RemoteControlSettingsInput>

/**
 * Which channels this screen writes, and nothing else: the reading is a snapshot reader's, so there
 * is no `load` here at all.
 *
 * Every command answers the same `RemoteSettingsSaveResult`, so the two unwraps are written once.
 * They are two separate refusals and both are asked: `answer.ok` is the CHANNEL, and `value.ok` is
 * what the settings service decided.
 */
export class RemoteControlSettingsEffects {
  static async run(
    effect: RemoteControlSettingsEffect,
    ports: RemoteControlSettingsPorts,
  ): Promise<void> {
    try {
      if (effect.effect === 'save') {
        const answer = await window.appClient.remoteSettings.saveListener(effect.value)
        if (!answer.ok)
          return ports.dispatch({
            input: 'failed',
            detail: RemoteControlSettingsEffects.transportDetail(answer.error),
          })
        if (!answer.value.ok)
          return ports.dispatch({
            input: 'saved',
            ok: false,
            detail: RemoteControlSettingsModel.refusalTextOf(answer.value),
          })
        return ports.dispatch({ input: 'saved', ok: true })
      }
      else if (effect.effect === 'copy-bundle') {
        const answer = await window.appClient.clipboard.writeText(effect.text)
        return ports.dispatch({
          input: 'settled',
          refusal: answer.ok
            ? null
            : RemoteControlSettingsEffects.transportDetail(answer.error),
        })
      }
      else if (effect.effect === 'pairing-connect')
        return RemoteControlSettingsEffects.settle(
          window.appClient.remoteSettings.connectPairing(effect.text),
          ports,
        )
      else if (effect.effect === 'profile-endpoint')
        return RemoteControlSettingsEffects.settle(
          window.appClient.remoteSettings.setProfileEndpoint(effect.profileId, effect.endpoint),
          ports,
        )
      else if (effect.effect === 'profile-retry')
        return RemoteControlSettingsEffects.settle(
          window.appClient.remoteSettings.retryProfile(effect.profileId),
          ports,
        )
      else if (effect.effect === 'profile-forget')
        return RemoteControlSettingsEffects.settle(
          window.appClient.remoteSettings.forgetProfile(effect.profileId),
          ports,
        )
      else if (effect.effect === 'inbound-revoke')
        return RemoteControlSettingsEffects.settle(
          window.appClient.remoteSettings.revokeInbound(
            effect.remoteComputerId,
            effect.remoteEndpointId,
          ),
          ports,
        )
      else
        throw new Error(`Unknown remote control settings effect: ${JSON.stringify(effect)}`)
    } catch {
      // A call that never returned would otherwise leave the screen with a command in flight for
      // ever, and every button on it drawn dead.
      return RemoteControlSettingsEffects.rejected(effect, ports)
    }
  }

  private static async settle(
    call: Promise<IpcResult<RemoteSettingsSaveResult>>,
    ports: RemoteControlSettingsPorts,
  ): Promise<void> {
    const answer = await call
    if (!answer.ok)
      return ports.dispatch({
        input: 'settled',
        refusal: RemoteControlSettingsEffects.transportDetail(answer.error),
      })
    ports.dispatch({
      input: 'settled',
      refusal: answer.value.ok ? null : RemoteControlSettingsModel.refusalTextOf(answer.value),
    })
  }

  private static rejected(
    effect: RemoteControlSettingsEffect,
    ports: RemoteControlSettingsPorts,
  ): void {
    const detail = 'The main process call failed before returning a result'
    // The card's own save reports through the card; every command reports through its outcome line.
    if (effect.effect === 'save')
      ports.dispatch({ input: 'failed', detail })
    else if (effect.effect === 'copy-bundle'
      || effect.effect === 'pairing-connect'
      || effect.effect === 'profile-endpoint'
      || effect.effect === 'profile-retry'
      || effect.effect === 'profile-forget'
      || effect.effect === 'inbound-revoke')
      ports.dispatch({ input: 'settled', refusal: detail })
    else
      throw new Error(`Unknown remote control settings effect: ${JSON.stringify(effect)}`)
  }

  private static transportDetail(error: string): string {
    return `The main process did not answer: ${error}`
  }
}
