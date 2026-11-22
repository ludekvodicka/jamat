import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  LimitFact,
  LimitRecoveryAction,
  SessionLimitRecoveryInfo,
} from '../../../../../lib-orchestrator/limitRecovery/limitRecoveryApi.types'
import { LimitRecoveryPanel } from './limitRecoveryPanel'
import { LimitRecoveryText } from './limitRecoveryText'

describe('app-client-ui/renderer/panels/terminal/limitRecovery/limitRecoveryPanel', () => {
  const nowConst = 1_700_000_000_000
  const limitConst: LimitFact = { account: { accountId: 'main', label: 'Main' }, window: 'session', resetsAt: nowConst + 90 * 60_000 }
  const work = { accountId: 'work', label: 'Work' }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(nowConst)
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('says what each state means and which answers it offers', () => {
    const of = (info: SessionLimitRecoveryInfo) => LimitRecoveryText.of(info, nowConst)
    expect(of({ state: 'countdown', limit: limitConst, reason: 'switch', target: work, deadlineAt: nowConst + 42_000 })).toEqual({
      title: 'Account Main reached its 5-hour limit', lines: ['Switching to Work in 42 s.'],
      buttons: [{ action: 'now', label: 'Switch now' }, { action: 'cancel', label: 'Cancel' }] })
    expect(of({ state: 'countdown', limit: { ...limitConst, window: 'weekly' }, reason: 'resume', target: limitConst.account,
      deadlineAt: nowConst + 60_000 })).toMatchObject({ title: 'Account Main reached its weekly limit',
      lines: ['The limit has reset. Continuing on Main in 60 s.'], buttons: [{ label: 'Continue now' }, { label: 'Cancel' }] })
    expect(of({ state: 'countdown', limit: limitConst, reason: 'switch', target: work, deadlineAt: nowConst + 42_000,
      stopsBackgroundShells: true })).toMatchObject({
      lines: ['Switching to Work in 42 s.', 'Switching restarts the session and stops its background shells.'] })
    expect(of({ state: 'queued', limit: limitConst, reason: 'switch', target: work, position: 2 })).toMatchObject({
      lines: ['Switching to Work after the sessions ahead of it (place 2 in line).'], buttons: [{ action: 'cancel' }] })
    expect(of({ state: 'running', limit: limitConst, reason: 'resume', target: limitConst.account }))
      .toMatchObject({ lines: ['Continuing on Main…'], buttons: [] })
    expect(of({ state: 'waiting', limit: limitConst, wakeAt: nowConst + 2 * 3_600_000, nextAccount: work })).toMatchObject({
      lines: ['Every account is exhausted.', 'Jamat continues when Work resets, in about 2h 0m.', 'It resets in 1h 30m.'] })
    expect(of({ state: 'waiting', limit: { ...limitConst, resetsAt: null }, wakeAt: null, nextAccount: null })).toMatchObject({
      lines: ['Every account is exhausted.', 'No reset time is known yet; Jamat continues when an account has quota again.'] })
    expect(of({ state: 'failed', limit: limitConst, detail: 'The switch to Work failed' }))
      .toMatchObject({ lines: ['The switch to Work failed'], buttons: [{ action: 'dismiss', label: 'Close' }] })
  })

  it('draws only the states this build knows', () => {
    expect(LimitRecoveryText.drawable({ state: 'failed', limit: limitConst, detail: 'x' })).toBe(true)
    expect(LimitRecoveryText.drawable({ state: 'paused', limit: limitConst } as unknown as SessionLimitRecoveryInfo)).toBe(false)
  })

  it('counts down once a second and sends the pressed answer, showing a refusal', async () => {
    const acts: LimitRecoveryAction[] = []
    const view = render(<LimitRecoveryPanel info={{ state: 'countdown', limit: limitConst, reason: 'switch', target: work, deadlineAt: nowConst + 60_000 }}
      act={async (action) => { acts.push(action); return 'The switch is already running' }} />)
    expect(view.getByText('Switching to Work in 60 s.')).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
    expect(view.getByText('Switching to Work in 57 s.')).toBeTruthy()
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Switch now' })) })
    expect(acts).toEqual(['now'])
    expect(view.getByText('The switch is already running')).toBeTruthy()
  })

  it('draws no buttons on a remote tab', () => {
    const view = render(<LimitRecoveryPanel info={{ state: 'waiting', limit: limitConst, wakeAt: null, nextAccount: null }} />)
    expect(view.queryAllByRole('button')).toEqual([])
  })
})
