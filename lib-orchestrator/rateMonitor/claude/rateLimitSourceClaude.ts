import { ErrorText } from '../../shared/errorText'
import type { RateLimitSource, RateSourceReading } from '../rateMonitor'
import { ClaudeCredentialsReader } from './claudeCredentialsReader'
import { ClaudeUsageResponse } from './claudeUsageResponse'

/** What the endpoint answered before anything tried to read it, or the failure that ends the read. */
export type ClaudeUsageAnswer =
  | { ok: true; body: unknown }
  | { ok: false; reason: string }

/**
 * One GET, injected rather than called, so a test can assert what was sent and, more to the point,
 * that nothing was sent at all where this source must not spend a request.
 */
export type ClaudeUsageTransport =
  (url: string, headers: Record<string, string>) => Promise<ClaudeUsageAnswer>

/** The body under the cap, or the reason there is no usable one. */
type ClaudeUsageBody =
  | { ok: true; text: string }
  | { ok: false; reason: string }

export interface RateLimitSourceClaudeDeps {
  credentials?: ClaudeCredentialsReader
  transport?: ClaudeUsageTransport
  /** The tests answer with a body of their own through this; nothing in production passes it. */
  fetchImpl?: typeof fetch
  now?: () => number
}

/**
 * Claude's side of the monitor: the token the running Claude Code keeps for itself, spent on one
 * request against the usage endpoint that the same token was minted for.
 *
 * Two things about that endpoint shape this class. It counts requests and answers a client that asks
 * too often with a 429 that then stands, so a read this source can already tell will fail is not
 * made - an expired token ends the read here, without the request. And it is undocumented, so the
 * body is read tolerantly and everything that goes wrong comes back as a value: this source never
 * throws, because the cadence, the last good windows and the cache all live in the facade and a
 * rejection out of a timer would take them with it.
 */
export class RateLimitSourceClaude implements RateLimitSource {
  private static readonly usageUrlConst = 'https://api.anthropic.com/api/oauth/usage'
  private static readonly betaHeaderConst = 'oauth-2025-04-20'
  /**
   * Not decoration: without a User-Agent it recognises, the endpoint answers 429 and goes on
   * answering 429 afterwards. The version is the installed Claude Code's, read off a live 200.
   */
  private static readonly userAgentConst = 'claude-code/2.1.233'
  private static readonly requestTimeoutMillisecondsConst = 10_000
  /**
   * The answer is not merely parsed and dropped: it is kept in `raw` for the lifetime of the process
   * and structured-cloned to the renderer on every Debug read, so its size is this process's problem
   * rather than the server's. A usage answer is a few kilobytes; anything past a megabyte is not one,
   * and the read fails with the last good windows left standing. The same cap V2 read this endpoint
   * under.
   */
  private static readonly maximumResponseBytesConst = 1_048_576
  /**
   * A token that expires while the request is in flight costs a 401 AND a request against a counter,
   * so the last half minute of a token's life is treated as spent. Nothing is lost by it: the poll
   * is ten minutes apart and Claude Code renews well before this.
   */
  private static readonly expiryMarginMillisecondsConst = 30_000

  readonly agentId = 'claude' as const

  private readonly credentials: ClaudeCredentialsReader
  private readonly transport: ClaudeUsageTransport
  private readonly now: () => number

  constructor(deps: RateLimitSourceClaudeDeps = {}) {
    this.credentials = deps.credentials ?? new ClaudeCredentialsReader()
    const fetchImpl = deps.fetchImpl ?? fetch
    this.transport = deps.transport
      ?? ((url, headers) => RateLimitSourceClaude.httpGet(fetchImpl, url, headers))
    this.now = deps.now ?? (() => Date.now())
  }

  async read(): Promise<RateSourceReading> {
    const credentials = await this.credentials.read()
    if (credentials.kind === 'missing')
      return { kind: 'unconfigured', reason: credentials.reason, oauthExpiresAt: null }
    else if (credentials.kind === 'ok')
      return await this.readWith(credentials.accessToken, credentials.expiresAt)
    else
      // The reading itself never reaches the message: the one thing it can carry is the one thing
      // that must not end up in a string anybody reports, logs or shows.
      throw new Error('Unknown Claude credentials reading')
  }

  /** Nothing lives between two reads here; the Codex source is where a child has to be ended. */
  stop(): void {}

  /**
   * The token is an argument and never a field: it is worth one request, and this class holding it
   * would be this class able to leak it.
   */
  private async readWith(
    accessToken: string,
    expiresAt: number | null,
  ): Promise<RateSourceReading> {
    if (RateLimitSourceClaude.spent(expiresAt, this.now()))
      return {
        kind: 'failed',
        reason: 'OAuth token expired; the running Claude Code refreshes it',
        oauthExpiresAt: expiresAt,
      }
    const answer = await this.transport(RateLimitSourceClaude.usageUrlConst, {
      'authorization': `Bearer ${accessToken}`,
      'anthropic-beta': RateLimitSourceClaude.betaHeaderConst,
      'user-agent': RateLimitSourceClaude.userAgentConst,
    })
    if (!answer.ok) return { kind: 'failed', reason: answer.reason, oauthExpiresAt: expiresAt }
    const mapped = ClaudeUsageResponse.of(answer.body)
    // Field by field, and `raw` is the response BODY: the credential travelled in a request header
    // and the endpoint answers with usage, so nothing of the login can be in what is kept here.
    return {
      kind: 'ok',
      windows: mapped.windows,
      extras: mapped.extras,
      raw: answer.body,
      oauthExpiresAt: expiresAt,
    }
  }

  private static spent(expiresAt: number | null, now: number): boolean {
    if (expiresAt === null) return false
    return expiresAt - RateLimitSourceClaude.expiryMarginMillisecondsConst <= now
  }

  private static async httpGet(
    fetchImpl: typeof fetch,
    url: string,
    headers: Record<string, string>,
  ): Promise<ClaudeUsageAnswer> {
    try {
      const response = await fetchImpl(url, {
        headers,
        signal: AbortSignal.timeout(RateLimitSourceClaude.requestTimeoutMillisecondsConst),
      })
      const body = await RateLimitSourceClaude.cappedText(response)
      if (!body.ok) return body
      if (!response.ok)
        return {
          ok: false,
          reason: `the usage endpoint answered ${response.status}: ${body.text.slice(0, 200)}`,
        }
      return { ok: true, body: JSON.parse(body.text) }
    } catch (error) {
      return { ok: false, reason: `the usage endpoint could not be read: ${ErrorText.of(error)}` }
    }
  }

  /**
   * Read chunk by chunk and counted, because the cap has to hold before the bytes are in memory: the
   * 10 second abort bounds how long the endpoint may take and says nothing about how much it may
   * send. Past the cap the rest is cancelled rather than drained - there is nothing here to read.
   */
  private static async cappedText(response: Response): Promise<ClaudeUsageBody> {
    if (response.body === null) return { ok: true, text: '' }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    let bytes = 0
    let chunk = await reader.read()
    while (chunk.done !== true) {
      bytes += chunk.value.byteLength
      if (bytes > RateLimitSourceClaude.maximumResponseBytesConst) {
        await reader.cancel()
        return {
          ok: false,
          reason: 'the usage endpoint answered more than '
            + `${RateLimitSourceClaude.maximumResponseBytesConst} bytes, which is not a usage answer`,
        }
      }
      text += decoder.decode(chunk.value, { stream: true })
      chunk = await reader.read()
    }
    return { ok: true, text: text + decoder.decode() }
  }
}
