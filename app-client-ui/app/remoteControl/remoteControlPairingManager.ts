import { dirname } from 'node:path'

import type { ConfigStore } from '../../../lib-orchestrator/configStore/configStore'
import type { ConfigOpResult } from '../../../lib-orchestrator/configStore/configStore.types'
import type {
  RemoteControlPeerEndpoint,
  RemoteControlPeerIdentity,
  RemoteControlPeerPairingBundle,
  RemoteControlPeerProfile,
} from '../../../lib-orchestrator/remoteControl/remoteControlPeerApi.types'
import { RemoteControlPairing } from '../../../lib-orchestrator/remoteControl/remoteControlPairing'
import { RemoteControlPairingProbe } from '../../../lib-orchestrator/remoteControl/remoteControlPairingProbe'
import { AtomicJsonFile } from '../../../lib-orchestrator/shared/atomicJsonFile'
import { ErrorText } from '../../shared/errorText'
import {
  RemoteControlSettings,
  type RemoteControlSettingsValue,
} from '../../shared/remoteControlSettings'
import { RemoteControlSettingsSection } from './remoteControlSettingsSection'
import type { RemotePeerCredentialStore } from './remotePeerCredentialStore'

export type RemoteControlPairingImportResult =
  | { ok: true; value: RemoteControlPeerProfile }
  | {
      ok: false
      code:
        | 'config-refused'
        | 'invalid-bundle'
        | 'identity-conflict'
        | 'not-confirmed'
        | 'probe-failed'
      detail: string
    }

/**
 * What a person is shown before a machine is trusted. The fingerprint is the whole point: it is the
 * one field that cannot be guessed from a name, so it is what the two people compare out of band.
 */
export interface RemoteControlPairingConfirmRequest {
  remoteComputerId: string
  remoteEndpointId: string
  displayName: string
  fingerprint: string
  /** 'bundle' pinned the key before the first dial; 'address' pins whatever the address served. */
  source: 'bundle' | 'address'
}

/**
 * Pairing as this computer's OUTBOUND half, and nothing else: an accepted import writes one profile
 * to `config.json` and touches no trust file. Until 2026-09-07 the same call also wrote, or revoked,
 * the other computer's right to reach in here, which is why it needed two stores, a rollback and a
 * hang-up callback. Reaching in is now the other computer's own dialog to answer
 * (`RemoteInboundApprovalManager`), so this class has one store and one write.
 */
export class RemoteControlPairingManager {
  private publishedBundle: RemoteControlPeerPairingBundle | null = null

  constructor(
    private readonly configStore: ConfigStore,
    /**
     * Narrow on purpose: an outbound pin may still not disagree with an inbound one already held
     * for the same identity, and that check is the only thing pairing has to ask the trust file.
     */
    private readonly credentials: Pick<RemotePeerCredentialStore, 'assertInboundIdentity'>,
    private readonly identity: RemoteControlPeerIdentity,
    private readonly publicBundleFile: string,
    /**
     * The human gate, and the reason it is a callback rather than a dialog call: this class decides
     * WHETHER to ask and what to show, the shell decides how to ask, and the tests answer without
     * an Electron window.
     */
    private readonly confirm:
      (request: RemoteControlPairingConfirmRequest) => Promise<boolean>,
  ) {}

  publish(endpoint: RemoteControlPeerEndpoint): RemoteControlPeerPairingBundle {
    const bundle = RemoteControlPairing.bundle(this.identity, endpoint)
    AtomicJsonFile.ensureDirectory(dirname(this.publicBundleFile))
    AtomicJsonFile.write(this.publicBundleFile, bundle)
    this.publishedBundle = structuredClone(bundle)
    return structuredClone(bundle)
  }

  bundle(): RemoteControlPeerPairingBundle {
    if (this.publishedBundle === null)
      throw new Error('The remote pairing bundle has not been published')
    return structuredClone(this.publishedBundle)
  }

  /**
   * A pasted bundle, which is the path that pins the other computer's key BEFORE anything is dialled.
   *
   * The question at the end of it is asked of a PERSON, and that is the whole of this method's
   * reason to be awaited. Until 2026-08-21 an import was an ordinary local operation behind the same
   * bearer token as `sessions.list`: an agent that read "run `jamat-v3 remote pairing import --file
   * ./bundle.json`" out of a terminal, a README or an issue would act on it, and the only trace was
   * one audit line. The reference the agent follows says never to infer pairing permission from a
   * request - which is a rule the code now keeps rather than a sentence the agent is trusted to obey.
   */
  async import(input: unknown): Promise<RemoteControlPairingImportResult> {
    let bundle: RemoteControlPeerPairingBundle
    try { bundle = RemoteControlPairing.parse(input) }
    catch (error) {
      return { ok: false, code: 'invalid-bundle', detail: ErrorText.of(error) }
    }
    return this.pair(bundle, 'bundle')
  }

  /**
   * A typed `host:port`, resolved to the same public bundle by asking the address for it. From the
   * answer on this is the paste path exactly - the person is shown the fingerprint and says yes -
   * with one difference they are told about: the key is whatever that address served, so the
   * fingerprint on the dialog is the only thing standing between them and the wrong computer.
   */
  async importFromAddress(
    endpoint: RemoteControlPeerEndpoint,
  ): Promise<RemoteControlPairingImportResult> {
    const probed = await RemoteControlPairingProbe.fetch(endpoint)
    if (!probed.ok) return { ok: false, code: 'probe-failed', detail: probed.detail }
    return this.pair(probed.bundle, 'address')
  }

  /**
   * The question comes after the bundle has been checked against what is already pinned, so a
   * conflicting bundle is refused without anybody being interrupted.
   */
  private async pair(
    bundle: RemoteControlPeerPairingBundle,
    source: RemoteControlPairingConfirmRequest['source'],
  ): Promise<RemoteControlPairingImportResult> {
    try { this.credentials.assertInboundIdentity(bundle.identity) }
    catch (error) {
      return { ok: false, code: 'identity-conflict', detail: ErrorText.of(error) }
    }
    const settings = this.configStore.readSection(RemoteControlSettingsSection.spec)
    const existing = settings.profiles.find((candidate) =>
      candidate.remoteComputerId === bundle.identity.remoteComputerId
      && candidate.remoteEndpointId === bundle.identity.remoteEndpointId)
    if (existing
      && (existing.pinnedIdentity.publicKey !== bundle.identity.signing.publicKey
        || existing.pinnedIdentity.fingerprint !== bundle.identity.signing.fingerprint))
      return {
        ok: false,
        code: 'identity-conflict',
        detail: 'Remote endpoint is already pinned to another identity',
      }
    const confirmed = await this.confirm({
      remoteComputerId: bundle.identity.remoteComputerId,
      remoteEndpointId: bundle.identity.remoteEndpointId,
      displayName: bundle.identity.displayName,
      fingerprint: bundle.identity.signing.fingerprint,
      source,
    })
    if (!confirmed)
      return {
        ok: false,
        code: 'not-confirmed',
        detail: 'Pairing was not confirmed on this computer',
      }
    const profile = RemoteControlPairing.profile(bundle, {
      ...(existing === undefined ? {} : { profileId: existing.profileId }),
    })
    const saved = this.saveProfile(settings, profile)
    if (!saved.ok)
      return { ok: false, code: 'config-refused', detail: saved.detail }
    return { ok: true, value: profile }
  }

  private saveProfile(
    settings: RemoteControlSettingsValue,
    profile: RemoteControlPeerProfile,
  ): ConfigOpResult {
    return this.configStore.saveSection(
      RemoteControlSettingsSection.spec,
      RemoteControlSettings.withProfile(settings, profile),
    )
  }
}
