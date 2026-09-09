import { afterEach, describe, expect, it, vi } from 'vitest'

import { CodexRateLimitFixtures } from './fixtures/codexRateLimitFixtures'
import { FakeCodexAppServer } from './fixtures/fakeCodexAppServer'
import { RateLimitSourceCodex } from './rateLimitSourceCodex'

describe('lib-orchestrator/rateMonitor/codex/rateLimitSourceCodex', () => {
  const sources: RateLimitSourceCodex[] = []
  const nudges: number[] = []

  afterEach(() => {
    for (const source of sources.splice(0)) source.stop()
    nudges.length = 0
    vi.useRealTimers()
  })

  function sourceOf(server: FakeCodexAppServer): RateLimitSourceCodex {
    const source = new RateLimitSourceCodex({
      onNudge: () => nudges.push(nudges.length + 1),
      spawnImpl: server.spawnImpl,
      platform: 'linux',
      environment: {},
    })
    sources.push(source)
    return source
  }

  it('names itself codex', () => {
    expect(sourceOf(new FakeCodexAppServer()).agentId).toBe('codex')
  })

  it('answers ok with the mapped windows and the raw result beside them', async () => {
    const server = new FakeCodexAppServer({ autoAnswer: true })

    expect(await sourceOf(server).read()).toEqual({
      kind: 'ok',
      windows: [{
        durationMinutes: 10_080,
        usedPercent: 73,
        resetsAt: new Date(1_787_251_016 * 1000).toISOString(),
      }],
      extras: [],
      raw: CodexRateLimitFixtures.liveResult(),
      oauthExpiresAt: null,
    })
  })

  it('answers ok with no windows when the server answered a shape it cannot draw', async () => {
    const server = new FakeCodexAppServer({
      autoAnswer: true,
      rateLimits: CodexRateLimitFixtures.unusableResult(),
    })

    expect(await sourceOf(server).read()).toMatchObject({ kind: 'ok', windows: [] })
  })

  it('calls a machine without Codex unconfigured rather than failed', async () => {
    const error: NodeJS.ErrnoException = new Error('spawn codex ENOENT')
    error.code = 'ENOENT'

    expect(await sourceOf(new FakeCodexAppServer({ spawnError: error })).read()).toEqual({
      kind: 'unconfigured',
      reason: 'Codex is not installed',
      oauthExpiresAt: null,
    })
  })

  it('answers failed with the reason and never throws it', async () => {
    const server = new FakeCodexAppServer()
    const reading = sourceOf(server).read()

    server.child.writeStderr('codex: broken\n')
    server.child.exit(2)
    await vi.waitFor(() => expect(server.children).toHaveLength(2))
    server.child.exit(2)

    expect(await reading).toEqual({
      kind: 'failed',
      reason: 'The Codex app-server exited (2)',
      oauthExpiresAt: null,
    })
  })

  it('nudges on the one notification that says the numbers moved, and on nothing else', async () => {
    const server = new FakeCodexAppServer({ autoAnswer: true })
    const source = sourceOf(server)
    await source.read()

    server.child.notify('remoteControl/status/changed')
    server.child.notify('account/rateLimits/updated')
    server.child.notify('account/rateLimits/updated')

    await vi.waitFor(() => expect(nudges).toEqual([1, 2]))
  })

  it('ends the app-server on stop', async () => {
    const server = new FakeCodexAppServer({ autoAnswer: true })
    const source = sourceOf(server)
    await source.read()
    const child = server.child

    vi.useFakeTimers()
    source.stop()
    expect(child.stdin.ended).toBe(true)
    await vi.advanceTimersByTimeAsync(500)

    expect(child.killed).toBe(true)
  })
})
