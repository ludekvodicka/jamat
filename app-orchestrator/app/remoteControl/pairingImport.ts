import type { RemoteControlPairingManager } from './remoteControlPairingManager'
import type { RemoteControlStepResult } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type { RemoteControlPeerProfile } from '../../../lib-orchestrator/remoteControl/remoteControlPeerApi.types'

export class PairingImport {
  private readonly pairing: Pick<RemoteControlPairingManager, 'import'>

  private readonly reloadProfiles: () => void

  constructor(pairing: Pick<RemoteControlPairingManager, 'import'>, reloadProfiles: () => void) { this.pairing = pairing; this.reloadProfiles = reloadProfiles }

  async run(bundle: Parameters<RemoteControlPairingManager['import']>[0]): Promise<RemoteControlStepResult<RemoteControlPeerProfile>> {
    const imported = await this.pairing.import(bundle)
    if (imported.ok) {
      this.reloadProfiles()
      return { ok: true, value: imported.value }
    } else if (imported.code === 'config-refused')
      return { ok: false, error: { code: 'operation-failed', detail: imported.detail } }
    else if (imported.code === 'invalid-bundle')
      return { ok: false, error: { code: 'invalid-request', detail: imported.detail } }
    else if (imported.code === 'identity-conflict')
      return { ok: false, error: { code: 'conflict', detail: imported.detail } }
    // Refused by the person at the machine, which is a refusal and not a fault: the CLI says
    // so plainly rather than reporting something that looks like a bug.
    else if (imported.code === 'not-confirmed')
      return { ok: false, error: { code: 'forbidden', detail: imported.detail } }
    // Not reachable over the control API, which takes a bundle and never an address; named
    // anyway, because a code with no arm here would reach the CLI as a thrown sentence.
    else if (imported.code === 'probe-failed')
      return { ok: false, error: { code: 'unavailable', detail: imported.detail } }
    else
      throw new Error(`Unknown pairing import result: ${JSON.stringify(imported)}`)
  }
}
