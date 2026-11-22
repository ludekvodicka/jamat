import { describe, expect, it } from 'vitest'

import type { RemoteControlTerminal } from '../../../lib-orchestrator/remoteControl/remoteControlTerminal'
import { RemoteControlDeliverConst } from '../../../lib-orchestrator/remoteControl/remoteControlProtocol'
import type { SessionTranscriptReading } from '../../../lib-orchestrator/sessionTranscriptReader/sessionTranscriptReaderApi.types'
import { LimitRecoveryDelivery } from './limitRecoveryDelivery'

describe('app-orchestrator/app/limitRecovery/limitRecoveryDelivery', () => {
  const textConst = 'Jamat: the 5-hour usage limit of account Main has reset. Continue the work where you stopped.'

  function delivery(ok: boolean, turnAt: number | null, notLiveFirst = 0) {
    const calls: unknown[][] = []
    let notLive = notLiveFirst
    const terminal = {
      deliver: async (...args: unknown[]) => {
        calls.push(args)
        if (notLive > 0) {
          notLive -= 1
          return { ok: false, error: { code: 'not-found', detail: 'The session is not live', data: { reason: 'not-live', typed: false } } }
        }
        return ok ? { ok: true, value: {} } : { ok: false, error: { code: 'operation-failed', detail: 'composer not ready' } }
      },
    } as unknown as Pick<RemoteControlTerminal, 'deliver'>
    const reading: SessionTranscriptReading = turnAt === null ? { kind: 'none', code: 'transcript-not-found', reason: 'none' }
      : { kind: 'messages', messages: [{ role: 'user', text: textConst, at: turnAt, textTruncated: false }],
        bounds: { maxMessages: 10, maxCharactersPerMessage: 2_000, scannedBytes: 100 }, earlierContentOmitted: false }
    return { calls, delivery: new LimitRecoveryDelivery(terminal, { read: async () => reading }, async () => {}) }
  }

  it('pastes the instruction and waits for the composer as long as the terminal allows', async () => {
    const { calls, delivery: subject } = delivery(true, null)
    expect(await subject.deliver('s1', textConst)).toEqual({ ok: true })
    expect(calls[0]?.slice(0, 3)).toEqual(['s1', textConst, { input: 'paste',
      readyTimeoutMs: expect.any(Number), submitTimeoutMs: RemoteControlDeliverConst.submitTimeoutMillisecondsConst }])
    const ready = (calls[0]?.[2] as { readyTimeoutMs: number }).readyTimeoutMs
    expect(ready).toBeGreaterThan(RemoteControlDeliverConst.readyTimeoutMaximumMillisecondsConst - 1_000)
    expect(ready).toBeLessThanOrEqual(RemoteControlDeliverConst.readyTimeoutMaximumMillisecondsConst)
  })

  it('counts a failed delivery whose turn shows in the transcript as taken', async () => {
    expect(await delivery(false, Date.now() + 1_000).delivery.deliver('s1', textConst)).toEqual({ ok: true })
  })

  it('tries again while the new runtime is not listed yet', async () => {
    const { calls, delivery: subject } = delivery(true, null, 2)
    expect(await subject.deliver('s1', textConst)).toEqual({ ok: true })
    expect(calls).toHaveLength(3)
  })

  it('reports the terminal refusal when no turn shows', async () => {
    expect(await delivery(false, null).delivery.deliver('s1', textConst)).toEqual({ ok: false, detail: 'composer not ready' })
  })
})
