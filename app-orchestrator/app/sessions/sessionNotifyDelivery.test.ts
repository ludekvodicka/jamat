import { describe, expect, it } from 'vitest'

import type { RemoteControlStepResult, RemoteControlTerminalDeliverDto } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type { RemoteControlTerminalDeliverOptions } from '../../../lib-orchestrator/remoteControl/remoteControl'
import type { SessionInfo, SessionsSnapshot } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { SessionNotifyDelivery } from './sessionNotifyDelivery'

describe('app-client-ui/app/sessions/sessionNotifyDelivery', () => {
  function harness(sessions: Partial<SessionInfo>[], answer: RemoteControlStepResult<RemoteControlTerminalDeliverDto>): {
    delivery: SessionNotifyDelivery
    calls: { sessionId: string; text: string; options: RemoteControlTerminalDeliverOptions }[]
  } {
    const calls: { sessionId: string; text: string; options: RemoteControlTerminalDeliverOptions }[] = []
    const delivery = new SessionNotifyDelivery(
      { snapshot: () => ({ sessions }) as unknown as SessionsSnapshot },
      {
        deliver: async (sessionId, text, options) => {
          calls.push({ sessionId, text, options })
          return answer
        },
      },
      { read: async () => ({ state: 'unavailable', reason: 'none' }) as never },
    )
    return { delivery, calls }
  }

  const delivered: RemoteControlStepResult<RemoteControlTerminalDeliverDto> = {
    ok: true,
    value: {
      sessionId: 'coordinator', accepted: true, characterCount: 4, delivered: true, input: 'paste', composeProof: 'text',
      proof: 'transcript', submitKey: 'enter', readyAfterMs: 1, submittedAfterMs: 1,
    },
  }
  const refused = (reason: string, typed: boolean): RemoteControlStepResult<RemoteControlTerminalDeliverDto> => ({
    ok: false,
    error: { code: 'conflict', detail: reason, data: { stage: typed ? 'submit' : 'ready', reason, typed, entered: 0, hint: null, composer: null } },
  })
  const live = { sessionId: 'coordinator', kind: 'agent' as const, life: 'live' as const }

  it('types the line into a live agent session, queued behind a running turn', async () => {
    const it_ = harness([live], delivered)

    expect(await it_.delivery.deliver('coordinator', 'wake')).toBe('delivered')
    expect(it_.calls).toEqual([{ sessionId: 'coordinator', text: 'wake', options: expect.objectContaining({ input: 'paste', queue: true }) }])
  })

  it('tries again later over a draft, a dialog or a session that does not run, and never types twice', async () => {
    expect(await harness([live], refused('foreign-draft', false)).delivery.deliver('coordinator', 'wake')).toBe('retry')
    expect(await harness([live], refused('dialog', false)).delivery.deliver('coordinator', 'wake')).toBe('retry')
    expect(await harness([live], refused('unproven', true)).delivery.deliver('coordinator', 'wake')).toBe('delivered')
    const ended = harness([{ ...live, life: 'ended' }], delivered)
    expect(await ended.delivery.deliver('coordinator', 'wake')).toBe('retry')
    expect(ended.calls).toEqual([])
  })

  it('gives up on a session that no longer exists or has no composer', async () => {
    expect(await harness([], delivered).delivery.deliver('coordinator', 'wake')).toBe('gone')
    expect(await harness([{ ...live, kind: 'shell' }], delivered).delivery.deliver('coordinator', 'wake')).toBe('gone')
  })
})
