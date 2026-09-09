import { describe, expect, it, vi } from 'vitest'

import { SessionRefreshRegistry } from './sessionRefreshRegistry'

describe('app-client-ui/renderer/shell/sessionRefreshRegistry', () => {
  it('notifies only the panel registered for the restarted session', () => {
    const registry = new SessionRefreshRegistry()
    const first = vi.fn()
    const second = vi.fn()
    registry.registerRefresh('first', first)
    registry.registerRefresh('second', second)

    registry.restarted('second')
    registry.restarted('missing')

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('does not let an old disposer remove a newer registration', () => {
    const registry = new SessionRefreshRegistry()
    const old = vi.fn()
    const current = vi.fn()
    const disposeOld = registry.registerRefresh('session-1', old)
    registry.registerRefresh('session-1', current)

    disposeOld()
    registry.restarted('session-1')

    expect(old).not.toHaveBeenCalled()
    expect(current).toHaveBeenCalledTimes(1)
  })

  it('forgets the current registration when it is disposed', () => {
    const registry = new SessionRefreshRegistry()
    const refresh = vi.fn()
    registry.registerRefresh('session-1', refresh)()

    registry.restarted('session-1')

    expect(refresh).not.toHaveBeenCalled()
  })
})
