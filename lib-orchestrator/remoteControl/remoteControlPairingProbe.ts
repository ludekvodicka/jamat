import type {
  RemoteControlPeerEndpoint,
  RemoteControlPeerPairingBundle,
} from './remoteControlPeerApi.types'
import { RemoteControlPairing } from './remoteControlPairing'
import { ErrorText } from '../shared/errorText'

export type RemoteControlPairingProbeResult =
  | { ok: true; bundle: RemoteControlPeerPairingBundle }
  | { ok: false; detail: string }

/**
 * The typed `host:port` turned into the same public bundle a paste would have carried, by asking
 * whatever answers at that address for it.
 *
 * What it talks to is a stranger by definition - the address was typed, nothing about it is pinned
 * yet - so every part of the exchange is bounded: one GET and no other method, a timeout over the
 * whole of it, a body cap read while the bytes arrive rather than after, a refused redirect so a
 * `302` cannot move the answer to another host, and `RemoteControlPairing.parse` as the only way
 * out. A lying server therefore reaches the person as a well-formed public bundle whose fingerprint
 * they are asked to compare, or as a refusal, and as nothing else.
 */
export class RemoteControlPairingProbe {
  static readonly timeoutMillisecondsConst = 5_000
  static readonly maximumBodyBytesConst = 65_536
  private static readonly pathConst = '/api/v3/peer/pairing'

  static async fetch(
    endpoint: RemoteControlPeerEndpoint,
    options?: { timeoutMilliseconds?: number },
  ): Promise<RemoteControlPairingProbeResult> {
    try {
      const response = await fetch(RemoteControlPairingProbe.url(endpoint), {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(options?.timeoutMilliseconds
          ?? RemoteControlPairingProbe.timeoutMillisecondsConst),
      })
      if (response.status !== 200) {
        // Dropped rather than read: an answer this is not going to parse still holds a connection
        // open until somebody lets go of its body.
        void response.body?.cancel().catch(() => undefined)
        return {
          ok: false,
          detail: `That address answered ${response.status} for its pairing info`,
        }
      }
      const text = await RemoteControlPairingProbe.read(response)
      return { ok: true, bundle: RemoteControlPairing.parse(JSON.parse(text)) }
    } catch (error) {
      return { ok: false, detail: ErrorText.of(error) }
    }
  }

  private static async read(response: Response): Promise<string> {
    const body = response.body
    if (body === null) return ''
    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        total += chunk.value.byteLength
        // Counted as it arrives, so a server that promises a bundle and sends a gigabyte is dropped
        // at the cap instead of being buffered whole and measured afterwards.
        if (total > RemoteControlPairingProbe.maximumBodyBytesConst)
          throw new Error('That address answered with more pairing info than this build reads')
        chunks.push(chunk.value)
      }
    } finally {
      await reader.cancel().catch(() => undefined)
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  private static url(endpoint: RemoteControlPeerEndpoint): string {
    const host = endpoint.host.includes(':')
      ? `[${endpoint.host.replace(/^\[|\]$/g, '')}]`
      : endpoint.host
    return `http://${host}:${endpoint.port}${RemoteControlPairingProbe.pathConst}`
  }
}
