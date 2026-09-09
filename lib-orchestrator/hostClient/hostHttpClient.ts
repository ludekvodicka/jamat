import type { HostDescriptor, HostHello, HostOpName } from '../../app-host/app/wire/hostWire.js'
import { ErrorText } from '../shared/errorText'
import type { HostCallFailure, HostCallResult, HostHelloReading } from './hostClient.types'

/** What the Host answered before anything tried to read it, or the failure that ends the call. */
type HostHttpAnswer =
  | { ok: true; status: number; text: string }
  | HostCallFailure

/**
 * One Host operation over loopback HTTP, with the descriptor's token. Every failure comes back as a
 * value, because a client that cannot reach its Host is a state of the snapshot and not an exception
 * anybody up the stack can do anything about.
 */
export class HostHttpClient {
  private static readonly requestTimeoutMillisecondsConst = 15_000
  /**
   * A ping is not an operation: it is asked while somebody watches, so it gives up in seconds rather
   * than holding the fifteen an operation is allowed. Requests must not pile up behind one another.
   */
  private static readonly helloTimeoutMillisecondsConst = 3_000

  constructor(private readonly descriptorOf: () => HostDescriptor | null) {}

  /**
   * A refused or timed-out connection is `host-unreachable`; anything the Host answered is
   * `op-rejected` carrying the status it answered with. The status travels because what a refusal
   * MEANS cannot be read off a single code: 429 is a ceiling that moves, 409 is a state that
   * changes, 400 is a request that never becomes valid. What does not travel as evidence is the
   * message - lease loss is `no-lease` only where it can be known rather than guessed, from the
   * keeper's own `expiresAt` and never from an error string.
   */
  async call<T>(name: HostOpName, body: Record<string, unknown>): Promise<HostCallResult<T>> {
    const descriptor = this.descriptorOf()
    if (descriptor === null)
      return { ok: false, code: 'host-unreachable', detail: `${name}: no Host descriptor is published` }
    const answered = await HostHttpClient.send(
      name,
      `http://127.0.0.1:${descriptor.port}/op/${name}`,
      {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${descriptor.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      HostHttpClient.requestTimeoutMillisecondsConst,
    )
    if (!answered.ok) return answered
    return HostHttpClient.parsed<T>(name, answered.status, answered.text)
  }

  /**
   * `GET /hello` is the cheapest question there is - the Host answers it from memory - and the only
   * one that carries its build. It sits behind the same authorization as an op, which is why a ping
   * belongs to whoever holds the descriptor and never to a renderer.
   */
  async hello(): Promise<HostCallResult<HostHelloReading>> {
    const descriptor = this.descriptorOf()
    if (descriptor === null)
      return { ok: false, code: 'host-unreachable', detail: 'hello: no Host descriptor is published' }
    const begun = performance.now()
    const answered = await HostHttpClient.send(
      'hello',
      `http://127.0.0.1:${descriptor.port}/hello`,
      { headers: { authorization: `Bearer ${descriptor.token}` } },
      HostHttpClient.helloTimeoutMillisecondsConst,
    )
    // Measured around the whole exchange, including the body: a Host that answers its headers and
    // then stalls is slow, and rounding it here keeps the reading a number and not a float to render.
    const latencyMilliseconds = Math.round(performance.now() - begun)
    if (!answered.ok) return answered
    const parsed = HostHttpClient.parsed<HostHello>('hello', answered.status, answered.text)
    if (!parsed.ok) return parsed
    return { ok: true, value: { hello: parsed.value, latencyMilliseconds } }
  }

  private static async send(
    what: string,
    url: string,
    init: RequestInit,
    timeoutMilliseconds: number,
  ): Promise<HostHttpAnswer> {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMilliseconds),
      })
      const text = await response.text()
      if (!response.ok)
        return {
          ok: false,
          code: 'op-rejected',
          status: response.status,
          detail: `${what} answered ${response.status}: ${HostHttpClient.messageOf(text)}`,
        }
      return { ok: true, status: response.status, text }
    } catch (error) {
      return { ok: false, code: 'host-unreachable', detail: `${what}: ${ErrorText.of(error)}` }
    }
  }

  private static parsed<T>(what: string, status: number, text: string): HostCallResult<T> {
    try {
      return { ok: true, value: JSON.parse(text) as T }
    } catch (error) {
      // The status is the Host's own, not a stand-in: an answer it called a success and this client
      // could not read says the operation may well have run, which is not the same as a refusal.
      return {
        ok: false,
        code: 'op-rejected',
        status,
        detail: `${what} answered unreadable JSON (${ErrorText.of(error)})`,
      }
    }
  }

  private static messageOf(text: string): string {
    try {
      const parsed: unknown = JSON.parse(text)
      if (parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string')
        return (parsed as { error: string }).error
    } catch { /* not the Host's error shape, so the body itself is the best message there is */ }
    return text.slice(0, 200)
  }
}
