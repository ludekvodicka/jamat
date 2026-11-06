import { describe, expect, it } from 'vitest'

import type { RemoteControlStepResult, RemoteControlTerminalDeliverDto } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type { RemoteControlTerminalDeliverOptions } from '../../../lib-orchestrator/remoteControl/remoteControl'
import type { SessionInfo, SessionsSnapshot } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { SessionTranscriptReading } from '../../../lib-orchestrator/sessionTranscriptReader/sessionTranscriptReaderApi.types'
import { SessionNotifyDelivery } from './sessionNotifyDelivery'

describe('app-client-ui/app/sessions/sessionNotifyDelivery', () => {
  const none: SessionTranscriptReading = { kind: 'none', code: 'transcript-not-found', reason: 'none' }
  const turns = (...messages: { text: string; at: number }[]): SessionTranscriptReading => ({
    kind: 'messages',
    messages: messages.map((message) => ({ role: 'user', textTruncated: false, ...message })),
    bounds: { maxMessages: 50, maxCharactersPerMessage: 4_000, scannedBytes: 1 },
    earlierContentOmitted: false,
  })
  function harness(sessions: Partial<SessionInfo>[], answer: RemoteControlStepResult<RemoteControlTerminalDeliverDto>, input: {
    transcript?: SessionTranscriptReading
  } = {}): {
    delivery: SessionNotifyDelivery
    calls: { sessionId: string; text: string; options: RemoteControlTerminalDeliverOptions }[]
    holds: string[]
  } {
    const calls: { sessionId: string; text: string; options: RemoteControlTerminalDeliverOptions }[] = []
    const holds: string[] = []
    const delivery = new SessionNotifyDelivery(
      {
        snapshot: () => ({ sessions }) as unknown as SessionsSnapshot,
        deliveryPending: (sessionId, pending) => { holds.push(`${pending ? 'hold' : 'release'} ${sessionId}`) },
      },
      {
        deliver: async (sessionId, text, options) => {
          calls.push({ sessionId, text, options })
          return answer
        },
      },
      { read: async () => input.transcript ?? none },
    )
    return { delivery, calls, holds }
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

    expect(await it_.delivery.deliver('coordinator', 'wake', 0)).toBe('delivered')
    expect(it_.calls).toEqual([{ sessionId: 'coordinator', text: 'wake', options: expect.objectContaining({ input: 'paste', queue: true }) }])
  })

  it('tries again later over a draft, a dialog or a session that does not run, and never types twice', async () => {
    expect(await harness([live], refused('foreign-draft', false)).delivery.deliver('coordinator', 'wake', 0)).toBe('retry')
    expect(await harness([live], refused('dialog', false)).delivery.deliver('coordinator', 'wake', 0)).toBe('retry')
    const ended = harness([{ ...live, life: 'ended' }], delivered)
    expect(await ended.delivery.deliver('coordinator', 'wake', 0)).toBe('retry')
    expect(ended.calls).toEqual([])
  })

  it('answers typed, not delivered, for a line that reached the composer without a proven submit (Mirabia 133)', async () => {
    expect(await harness([live], refused('unproven', true)).delivery.deliver('coordinator', 'wake', 0)).toBe('typed')
    expect(await harness([live], refused('draft-remains', true)).delivery.deliver('coordinator', 'wake', 0)).toBe('typed')
  })

  it('types nothing for a line the transcript already holds since the item was written', async () => {
    const it_ = harness([live], delivered, { transcript: turns({ text: 'wake', at: 20 }) })

    expect(await it_.delivery.deliver('coordinator', 'wake', 10)).toBe('delivered')
    expect(it_.calls).toEqual([])
    expect(await harness([live], delivered, { transcript: turns({ text: 'wake', at: 5 }) }).delivery.deliver('coordinator', 'wake', 10)).toBe('delivered')
    expect(await harness([live], refused('unproven', true), { transcript: turns({ text: 'wake', at: 5 }) }).delivery.deliver('coordinator', 'wake', 10)).toBe('typed')
  })

  it('counts a typed line taken only when the transcript holds its turn since the item, and holds the gate as pending input', async () => {
    const taken = (transcript: SessionTranscriptReading) => harness([live], delivered, { transcript }).delivery.taken('coordinator', 'wake', 10)
    expect(await taken(turns({ text: 'wake', at: 11 }))).toBe(true)
    expect(await taken(turns({ text: 'wake', at: 9 }))).toBe(false)
    expect(await taken(turns({ text: 'other', at: 11 }))).toBe(false)
    expect(await taken(none)).toBe(false)

    const it_ = harness([live], delivered)
    it_.delivery.holding('coordinator', true)
    it_.delivery.holding('coordinator', false)
    expect(it_.holds).toEqual(['hold coordinator', 'release coordinator'])
  })

  it('gives up on a session that no longer exists or has no composer', async () => {
    expect(await harness([], delivered).delivery.deliver('coordinator', 'wake', 0)).toBe('gone')
    expect(await harness([{ ...live, kind: 'shell' }], delivered).delivery.deliver('coordinator', 'wake', 0)).toBe('gone')
  })
})
