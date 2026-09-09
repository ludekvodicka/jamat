import { describe, expect, it } from 'vitest'

import type {
  SessionInfo,
  SessionsSnapshot,
} from '../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { SessionSelectorResolver } from './sessionSelectorResolver'

describe('app-client-cli/app/sessionSelectorResolver', () => {
  it('resolves the only exact number match to its session id', async () => {
    const resolver = SessionSelectorResolverTest.resolver([
      SessionSelectorResolverTest.session('session-1', '001', 'Q:/Apps/One'),
      SessionSelectorResolverTest.session('session-2', '002', 'Q:/Apps/Two'),
    ])

    await expect(resolver.canonical({ kind: 'number', number: '001' })).resolves.toEqual({
      ok: true,
      value: { kind: 'sessionId', sessionId: 'session-1' },
    })
  })

  it('returns safe conflicts without choosing by life or list order', async () => {
    const resolver = SessionSelectorResolverTest.resolver(Array.from(
      { length: 26 },
      (_, index) => SessionSelectorResolverTest.session(
        `session-${index + 1}`,
        '014-015',
        `Q:/Apps/${index + 1}`,
        index === 25 ? 'live' : 'ended',
      ),
    ))

    const result = await resolver.canonical({ kind: 'number', number: '014-015' })

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'conflict',
        detail: 'Several sessions match number 014-015',
      },
    })
    if (result.ok) throw new Error('Expected a session conflict')
    const candidates = (result.error.data as { candidates: unknown[] }).candidates
    expect(candidates).toHaveLength(26)
    expect(candidates[0]).toEqual({
      sessionId: 'session-1',
      number: '014-015',
      title: '014-015 Session',
      workingDirectory: 'Q:/Apps/1',
    })
    expect(JSON.stringify(result)).not.toContain('token')
    expect(JSON.stringify(result)).not.toContain('port')
  })

  it('returns an invalid snapshot error instead of reading a malformed worktree path', async () => {
    const value = {
      ...SessionSelectorResolverTest.snapshot([]),
      sessions: [{
        ...SessionSelectorResolverTest.session('session-1', '001', 'Q:/Apps/One'),
        worktree: null,
      }],
    }
    const resolver = new SessionSelectorResolver({
      list: () => Promise.resolve({ ok: true as const, value }),
    })

    await expect(resolver.canonical({ kind: 'number', number: '001' })).resolves.toEqual({
      ok: false,
      error: {
        code: 'operation-failed',
        detail: 'AppClientUI returned an invalid sessions snapshot',
      },
    })
  })

  it('uses Windows-equivalent paths but keeps POSIX case-sensitive paths distinct', async () => {
    const resolver = SessionSelectorResolverTest.resolver([
      SessionSelectorResolverTest.session('session-root', '001', 'Q:/Apps/One'),
      SessionSelectorResolverTest.session('session-child', '001', 'Q:/Apps/One/Child'),
    ])

    const platformCase = await resolver.canonical(
      { kind: 'number', number: '001' },
      process.platform === 'win32' ? 'q:\\apps\\one' : 'q:/Apps/One',
    )
    const contained = await resolver.canonical(
      { kind: 'number', number: '001' },
      'Q:/Apps',
    )

    if (process.platform === 'win32')
      expect(platformCase).toEqual({
        ok: true,
        value: { kind: 'sessionId', sessionId: 'session-root' },
      })
    else
      expect(platformCase).toMatchObject({ ok: false, error: { code: 'not-found' } })
    expect(contained).toMatchObject({ ok: false, error: { code: 'not-found' } })
  })

  it('keeps two exact directory matches ambiguous', async () => {
    const resolver = SessionSelectorResolverTest.resolver([
      SessionSelectorResolverTest.session('session-1', '001', 'Q:/Apps/One'),
      SessionSelectorResolverTest.session('session-2', '001', 'Q:/Apps/One'),
    ])

    await expect(resolver.canonical(
      { kind: 'number', number: '001' },
      'Q:/Apps/One',
    )).resolves.toMatchObject({ ok: false, error: { code: 'conflict' } })
  })

  it('returns not-found and rejects an invalid snapshot before selecting', async () => {
    const empty = SessionSelectorResolverTest.resolver([])
    const invalid = new SessionSelectorResolver({
      list: () => Promise.resolve({ ok: true, value: { sessions: [null] } }),
    })

    await expect(empty.canonical({ kind: 'number', number: '001' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'not-found' } })
    await expect(invalid.canonical({ kind: 'number', number: '001' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'operation-failed' } })
  })

  it('passes through a session id without listing and rejects its working directory', async () => {
    let calls = 0
    const resolver = new SessionSelectorResolver({
      list: () => {
        calls += 1
        return Promise.resolve({ ok: true, value: SessionSelectorResolverTest.snapshot([]) })
      },
    })

    await expect(resolver.canonical({ kind: 'sessionId', sessionId: 'session-1' }))
      .resolves.toEqual({
        ok: true,
        value: { kind: 'sessionId', sessionId: 'session-1' },
      })
    await expect(resolver.canonical(
      { kind: 'sessionId', sessionId: 'session-1' },
      'Q:/Apps/One',
    )).resolves.toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    expect(calls).toBe(0)
  })
})

class SessionSelectorResolverTest {
  static resolver(sessions: SessionInfo[]): SessionSelectorResolver {
    return new SessionSelectorResolver({
      list: () => Promise.resolve({
        ok: true,
        value: SessionSelectorResolverTest.snapshot(sessions),
      }),
    })
  }

  static snapshot(sessions: SessionInfo[]): SessionsSnapshot {
    return {
      revision: 1,
      reconciled: true,
      host: {
        presence: 'running',
        hostVersion: '1.0.0',
        hostInstanceId: 'host-1',
        liveCount: sessions.filter((session) => session.life === 'live').length,
        lastStartError: null,
      },
      categories: [],
      sessions,
      orphans: [],
    }
  }

  static session(
    sessionId: string,
    number: string,
    directory: string,
    life: SessionInfo['life'] = 'ended',
  ): SessionInfo {
    return {
      sessionId,
      kind: 'shell',
      title: `${number} Session`,
      titleParts: { number, name: 'Session' },
      tabTitle: `Project - ${number} Session`,
      directory: { mode: 'adHoc', path: directory },
      project: { kind: 'none' },
      life,
      activity: null,
      admits: [],
    }
  }
}
