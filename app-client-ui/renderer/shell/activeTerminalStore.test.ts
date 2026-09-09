import { describe, expect, it, vi } from 'vitest'

import { type ActiveTerminalReading, ActiveTerminalStore } from './activeTerminalStore'

describe('app-client-ui/renderer/shell/activeTerminalStore', () => {
  const workingConst: ActiveTerminalReading = {
    panelId: 'terminal:{"sessionId":"s-working"}',
    target: { kind: 'local', sessionId: 's-working' },
  }
  const waitingConst: ActiveTerminalReading = {
    panelId: 'terminal:{"sessionId":"s-waiting"}',
    target: { kind: 'local', sessionId: 's-waiting' },
  }

  it('has no active terminal before anything is written', () => {
    expect(new ActiveTerminalStore().current()).toBeNull()
  })

  it('publishes the terminal the active tab became', () => {
    const store = new ActiveTerminalStore()
    const woken = vi.fn()
    store.subscribe(woken)

    store.set(workingConst)

    expect(store.current()).toEqual(workingConst)
    expect(woken).toHaveBeenCalledTimes(1)
  })

  /**
   * The port publishes on every layout move, and most of them name the tab that was already in
   * front. Compared by value rather than by identity: the reading is built again from the panel id
   * each time, so a fresh object saying the same thing is what the store actually receives.
   */
  it('does not wake anybody for the tab that is already in front', () => {
    const store = new ActiveTerminalStore()
    store.set(workingConst)
    const held = store.current()
    const woken = vi.fn()
    store.subscribe(woken)

    store.set({ ...workingConst })

    expect(woken).not.toHaveBeenCalled()
    // The same object as well as the same value: a widget reading this through useSyncExternalStore
    // re-renders on a new identity alone.
    expect(store.current()).toBe(held)
  })

  it('wakes for a different terminal and again when the tab goes away', () => {
    const store = new ActiveTerminalStore()
    const woken = vi.fn()
    store.subscribe(woken)

    store.set(workingConst)
    store.set(waitingConst)
    store.set(null)

    expect(store.current()).toBeNull()
    expect(woken).toHaveBeenCalledTimes(3)
  })

  it('keeps an equal local and remote session id distinct', () => {
    const store = new ActiveTerminalStore()
    const woken = vi.fn()
    store.subscribe(woken)
    store.set(workingConst)

    store.set({
      panelId: 'terminal:{"target":{"kind":"remote","remoteEndpointId":"office","sessionId":"s-working"}}',
      target: { kind: 'remote', remoteEndpointId: 'office', sessionId: 's-working' },
    })

    expect(store.current()?.target).toEqual({
      kind: 'remote', remoteEndpointId: 'office', sessionId: 's-working',
    })
    expect(woken).toHaveBeenCalledTimes(2)
  })

  it('stays quiet when nothing was active and nothing becomes active', () => {
    const store = new ActiveTerminalStore()
    const woken = vi.fn()
    store.subscribe(woken)

    store.set(null)

    expect(woken).not.toHaveBeenCalled()
  })

  it('wakes every subscriber, and none that unsubscribed', () => {
    const store = new ActiveTerminalStore()
    const first = vi.fn()
    const second = vi.fn()
    store.subscribe(first)
    const stopSecond = store.subscribe(second)

    store.set(workingConst)
    stopSecond()
    store.set(waitingConst)

    expect(first).toHaveBeenCalledTimes(2)
    expect(second).toHaveBeenCalledTimes(1)
  })
})
