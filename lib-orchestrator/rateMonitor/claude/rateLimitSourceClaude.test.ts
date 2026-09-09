import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ClaudeCredentialsReader } from './claudeCredentialsReader'
import { ClaudeUsageFixtures } from './fixtures/claudeUsageFixtures'
import { type ClaudeUsageAnswer, RateLimitSourceClaude } from './rateLimitSourceClaude'

describe('lib-orchestrator/rateMonitor/claude/rateLimitSourceClaude', () => {
  const nowConst = 1_700_000_000_000
  const created: string[] = []

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  interface Call {
    url: string
    headers: Record<string, string>
  }

  interface Harness {
    source: RateLimitSourceClaude
    calls: Call[]
  }

  function home(oauth: Record<string, unknown> | null): string {
    const directory = mkdtempSync(join(tmpdir(), 'jamat-rate-claude-'))
    created.push(directory)
    if (oauth !== null)
      writeFileSync(
        join(directory, '.credentials.json'),
        JSON.stringify({ claudeAiOauth: oauth }),
        'utf8',
      )
    return directory
  }

  function harness(options: {
    oauth: Record<string, unknown> | null
    answer?: ClaudeUsageAnswer
  }): Harness {
    const calls: Call[] = []
    const answer: ClaudeUsageAnswer = options.answer
      ?? { ok: true, body: ClaudeUsageFixtures.live() }
    const source = new RateLimitSourceClaude({
      credentials: new ClaudeCredentialsReader(home(options.oauth)),
      transport: async (url, headers) => {
        calls.push({ url, headers })
        return answer
      },
      now: () => nowConst,
    })
    return { source, calls }
  }

  function login(expiresAt: number | null): Record<string, unknown> {
    return { accessToken: 'sk-ant-oat-access', refreshToken: 'sk-ant-ort-refresh', expiresAt }
  }

  it('calls a machine with no login unconfigured, and asks the endpoint nothing', async () => {
    const { source, calls } = harness({ oauth: null })

    const reading = await source.read()
    expect(reading.kind).toBe('unconfigured')
    expect(calls).toEqual([])
  })

  // The endpoint counts requests and answers a client that asks too often with a lasting 429, so a
  // read this source can already tell will fail must not cost one.
  it('ends an expired token before the request, not after a 401', async () => {
    const { source, calls } = harness({ oauth: login(nowConst - 1_000) })

    expect(await source.read()).toEqual({
      kind: 'failed',
      reason: 'OAuth token expired; the running Claude Code refreshes it',
      oauthExpiresAt: nowConst - 1_000,
    })
    expect(calls).toEqual([])
  })

  it('treats the last moments of a token as spent, so it cannot expire in flight', async () => {
    const { source, calls } = harness({ oauth: login(nowConst + 5_000) })

    expect((await source.read()).kind).toBe('failed')
    expect(calls).toEqual([])
  })

  it('sends the three headers the endpoint requires and nothing else', async () => {
    const { source, calls } = harness({ oauth: login(nowConst + 3_600_000) })

    await source.read()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://api.anthropic.com/api/oauth/usage')
    expect(Object.keys(calls[0]?.headers ?? {}).sort())
      .toEqual(['anthropic-beta', 'authorization', 'user-agent'])
    expect(calls[0]?.headers['authorization']).toBe('Bearer sk-ant-oat-access')
    expect(calls[0]?.headers['anthropic-beta']).toBe('oauth-2025-04-20')
    // Without a User-Agent the endpoint recognises it answers 429 and goes on answering 429.
    expect(calls[0]?.headers['user-agent']).toMatch(/^claude-code\/\d+\.\d+\.\d+$/)
  })

  it('maps the answered body and carries the expiry with it', async () => {
    const body = ClaudeUsageFixtures.live()
    const { source } = harness({ oauth: login(nowConst + 3_600_000), answer: { ok: true, body } })

    const reading = await source.read()
    expect(reading.kind).toBe('ok')
    if (reading.kind !== 'ok') throw new Error('the source failed a read it was given an answer for')
    expect(reading.windows).toHaveLength(3)
    expect(reading.extras).toEqual([{ label: 'Extra usage', detail: 'off' }])
    expect(reading.raw).toBe(body)
    expect(reading.oauthExpiresAt).toBe(nowConst + 3_600_000)
  })

  it('turns a refused or unreachable endpoint into a failed reading, never a throw', async () => {
    const { source } = harness({
      oauth: login(nowConst + 3_600_000),
      answer: { ok: false, reason: 'the usage endpoint answered 429: slow down' },
    })

    expect(await source.read()).toEqual({
      kind: 'failed',
      reason: 'the usage endpoint answered 429: slow down',
      oauthExpiresAt: nowConst + 3_600_000,
    })
  })

  it('reads a login that names no expiry', async () => {
    const { source, calls } = harness({ oauth: login(null) })

    const reading = await source.read()
    expect(reading.kind).toBe('ok')
    expect(reading.oauthExpiresAt).toBe(null)
    expect(calls).toHaveLength(1)
  })

  /**
   * The seam this subsystem exists behind: a real reader over a real file whose two tokens are
   * unmistakable, and a reading that must not carry either of them anywhere at all - not in a field,
   * not in a reason, not in the raw body kept for the Debug window.
   */
  it('carries no token out of the credentials file, in any reading it can produce', async () => {
    const accessSentinel = 'SENTINEL-ACCESS-8f2a1c'
    const refreshSentinel = 'SENTINEL-REFRESH-4d9b7e'
    const oauth = {
      accessToken: accessSentinel,
      refreshToken: refreshSentinel,
      expiresAt: nowConst + 3_600_000,
    }
    const readings = [
      await harness({ oauth }).source.read(),
      await harness({ oauth, answer: { ok: false, reason: 'refused' } }).source.read(),
      await harness({ oauth: { ...oauth, expiresAt: nowConst - 1 } }).source.read(),
      await harness({ oauth: null }).source.read(),
    ]

    for (const reading of readings) {
      const serialized = JSON.stringify(reading)
      expect(serialized).not.toContain(accessSentinel)
      expect(serialized).not.toContain(refreshSentinel)
    }
  })

  /** The default transport, over a fetch that answers a body of this test's own. */
  function overFetch(body: string, status = 200): RateLimitSourceClaude {
    return new RateLimitSourceClaude({
      credentials: new ClaudeCredentialsReader(home(login(nowConst + 3_600_000))),
      fetchImpl: () => Promise.resolve(new Response(body, { status })),
      now: () => nowConst,
    })
  }

  it('reads an ordinary answer through the transport it builds for itself', async () => {
    const reading = await overFetch(JSON.stringify(ClaudeUsageFixtures.live())).read()

    expect(reading.kind).toBe('ok')
    if (reading.kind !== 'ok') throw new Error('the source failed a read it was given an answer for')
    expect(reading.windows).toHaveLength(3)
  })

  // The answer is held in `raw` for the lifetime of the process and cloned to the renderer on every
  // Debug read, so an endpoint that answers a gigabyte is this process's problem, not the server's.
  it('refuses a body past the cap rather than holding whatever was sent', async () => {
    const reading = await overFetch('x'.repeat(1_048_577)).read()

    expect(reading).toEqual({
      kind: 'failed',
      reason: 'the usage endpoint answered more than 1048576 bytes, which is not a usage answer',
      oauthExpiresAt: nowConst + 3_600_000,
    })
  })

  it('carries a refusal and the start of what it said into the reason', async () => {
    const reading = await overFetch('slow down', 429).read()

    expect(reading).toEqual({
      kind: 'failed',
      reason: 'the usage endpoint answered 429: slow down',
      oauthExpiresAt: nowConst + 3_600_000,
    })
  })

  it('names itself claude and holds nothing that has to be stopped', () => {
    const { source } = harness({ oauth: null })

    expect(source.agentId).toBe('claude')
    // Twice, and inside the expect: this source owns no timer and no child, so stopping it is a
    // no-op that must stay one - including the second time, which is what a shutdown after an
    // already-stopped monitor does.
    expect(() => {
      source.stop()
      source.stop()
    }).not.toThrow()
  })
})
