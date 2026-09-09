import { describe, expect, it } from 'vitest'

import { IpcFailure } from './ipcFailure'

describe('app-client-ui/renderer/ipc/ipcFailure', () => {
  it('says nothing about a call that worked, with or without a value on it', () => {
    expect(IpcFailure.of({ ok: true, value: { ok: true } })).toBeNull()
    expect(IpcFailure.of({ ok: true, value: { ok: true, value: undefined } }, 'Merge')).toBeNull()
  })

  /** The channel never reached the main process, so nothing over there formed an opinion to report. */
  it('reports a channel that failed, which carries no code', () => {
    expect(IpcFailure.of({ ok: false, error: 'no bridge' })).toBe('no bridge')
    expect(IpcFailure.of({ ok: false, error: 'no bridge' }, 'Merge')).toBe('Merge failed: no bridge')
  })

  it('reports a library refusal with its code in front of the sentence', () => {
    const answer = { ok: true as const, value: { ok: false as const, code: 'dirty', detail: 'commit it first' } }

    expect(IpcFailure.of(answer)).toBe('dirty: commit it first')
    expect(IpcFailure.of(answer, 'Merge')).toBe('Merge failed: dirty: commit it first')
  })

  describe('unwrap', () => {
    it('hands back the value the channel carried', () => {
      expect(IpcFailure.unwrap({ ok: true, value: ['s-1', 's-2'] })).toEqual(['s-1', 's-2'])
    })

    // The twelve callers run under `started`, which catches and reports. A silent `undefined` would
    // have each of them carry on with nothing: a transfer lease that was never granted, a panel
    // claimed by nobody.
    it('throws the channel error rather than answering with nothing', () => {
      expect(() => IpcFailure.unwrap({ ok: false, error: 'no handler for tabs:claim-panel' }))
        .toThrow('no handler for tabs:claim-panel')
    })

    // `undefined` is what a void channel answers with, and it is NOT a failure.
    it('passes an undefined value through', () => {
      expect(IpcFailure.unwrap<void>({ ok: true, value: undefined })).toBe(undefined)
    })
  })
})
