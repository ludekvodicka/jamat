import { describe, expect, it, vi } from 'vitest'
import { StaleSessionTabs } from './staleSessionTabs'

const world = (open: string[], records: string[] | null) => {
  const close = vi.fn<(sessionId: string) => void>()
  const state = { open, records }
  const tabs = new StaleSessionTabs({
    openSessionIds: () => state.open,
    knows: (sessionId) => state.records === null ? null : state.records.includes(sessionId),
    close,
  })
  return { tabs, close, state }
}

describe('StaleSessionTabs', () => {
  it('closes the tab of a session without a record, once while it stays open', () => {
    const w = world(['live', 'gone'], ['live'])
    w.tabs.reconcile()
    w.tabs.reconcile()
    expect(w.close).toHaveBeenCalledExactlyOnceWith('gone')
  })

  it('closes nothing before the records file is read', () => {
    const w = world(['a'], null)
    w.tabs.reconcile()
    expect(w.close).not.toHaveBeenCalled()
    w.state.records = []
    w.tabs.reconcile()
    expect(w.close).toHaveBeenCalledExactlyOnceWith('a')
  })

  it('asks again for a tab that came back after it closed', () => {
    const w = world(['gone'], [])
    w.tabs.reconcile()
    w.state.open = []
    w.tabs.reconcile()
    w.state.open = ['gone']
    w.tabs.reconcile()
    expect(w.close).toHaveBeenCalledTimes(2)
  })

  it('leaves a collapsed script run to its hand-off', () => {
    const w = world(['run'], [])
    w.tabs.collapsedRun('run')
    w.tabs.reconcile()
    expect(w.close).not.toHaveBeenCalled()
  })
})
