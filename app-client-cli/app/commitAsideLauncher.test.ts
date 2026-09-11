import { describe, expect, it, vi } from 'vitest'
import { CommitAsideLauncher } from './commitAsideLauncher'

describe('app-client-cli/app/commitAsideLauncher', () => {
  it.each(['svn', 'git'] as const)('returns the %s fallback result after spawn without waiting for the human dialog', async (vcs) => {
    const open = vi.fn(async () => ({ ok: true as const, closed: new Promise<void>(() => {}) }))
    const request = { vcs, scope: 'Q:/app with spaces', messageFile: 'Q:/temp/message.txt', reason: 'jamat-unavailable' as const }
    expect(await new CommitAsideLauncher({ open }).open(request))
      .toEqual({ ok: true, value: { kind: 'opened-aside', tool: vcs === 'svn' ? 'tortoisesvn' : 'tortoisegit', scope: request.scope, reason: request.reason } })
    expect(open).toHaveBeenCalledExactlyOnceWith(request)
  })

  it('preserves the launch refusal', async () => {
    const open = vi.fn(async () => ({ ok: false as const, detail: 'Tortoise is missing' }))
    expect(await new CommitAsideLauncher({ open }).open({ vcs: 'svn', scope: 'Q:/app', messageFile: null, reason: 'session-not-open' }))
      .toEqual({ ok: false, error: { code: 'unavailable', detail: 'Tortoise is missing' } })
  })
})
