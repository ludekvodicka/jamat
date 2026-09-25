import { SessionsGroupsState, type SessionGroupAssignment } from '../../../shared/sessionsGroupsState'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IpcResult } from '../../../shared/appClientUiIpc'
import { useSessionsGroups } from './useSessionsGroups'

describe('app-client-ui/renderer/views/sessionsTree/useSessionsGroups', () => {
  afterEach(cleanup)

  it('refuses changes after a failed initial read and restores saved groups on retry', async () => {
    const ports = {
      loadGroupDefinitions: async () => ({ ok: true as const, value: SessionsGroupsState.defaultsConst }),
      loadGroups: vi.fn<() => Promise<IpcResult<readonly SessionGroupAssignment[]>>>()
        .mockRejectedValueOnce(new Error('Offline'))
        .mockResolvedValue({ ok: true, value: [{ key: 'category:work', group: 'pinned' as const }] }),
      assignGroup: vi.fn(async () => ({ ok: true as const, value: true })),
      subscribeGroups: () => () => {},
    }
    const { result } = renderHook(() => useSessionsGroups(ports))
    await waitFor(() => expect(result.current.error).toContain('Offline'))
    act(() => result.current.assign('session:one', 'priority'))
    expect(ports.assignGroup).not.toHaveBeenCalled()
    act(() => result.current.reload())
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect([...result.current.groups]).toEqual([['category:work', 'pinned']])
    expect(result.current.error).toBeNull()
  })

  it('prevents overlapping writes and keeps the saved groups after a rejected write', async () => {
    let settle!: (answer: IpcResult<boolean>) => void
    const ports = {
      loadGroupDefinitions: async () => ({ ok: true as const, value: SessionsGroupsState.defaultsConst }),
      loadGroups: async () => ({ ok: true as const, value: [{ key: 'category:work', group: 'pinned' as const }] }),
      assignGroup: vi.fn(() => new Promise<IpcResult<boolean>>((resolve) => { settle = resolve })),
      subscribeGroups: () => () => {},
    }
    const { result } = renderHook(() => useSessionsGroups(ports))
    await waitFor(() => expect(result.current.ready).toBe(true))
    act(() => {
      result.current.assign('session:one', 'priority')
      result.current.assign('session:two', 'none')
    })
    expect(ports.assignGroup).toHaveBeenCalledTimes(1)
    expect(ports.assignGroup).toHaveBeenCalledWith('session:one', 'priority')
    expect([...result.current.groups]).toEqual([['category:work', 'pinned']])
    await act(async () => settle({ ok: false, error: 'Write failed' }))
    expect(result.current.saving).toBe(false)
    expect([...result.current.groups]).toEqual([['category:work', 'pinned']])
    expect(result.current.error).toContain('Write failed')
    act(() => result.current.assign('session:two', 'none'))
    await act(async () => settle({ ok: true, value: true }))
    expect([...result.current.groups]).toEqual([['category:work', 'pinned'], ['session:two', 'none']])
  })

  /**
   * The fork's own write happens in the main process, so the tree hears about it the way it hears
   * about anything else it did not do: the event says only that the map moved, and the map is read
   * back whole.
   */
  it('reads the assignments back when somebody else writes one', async () => {
    const loaded: readonly SessionGroupAssignment[][] = [
      [{ key: 'session:parent', group: 'priority' }],
      [{ key: 'session:parent', group: 'priority' }, { key: 'session:fork', group: 'priority' }],
    ]
    let notify!: () => void
    let reads = 0
    const ports = {
      loadGroupDefinitions: async () => ({ ok: true as const, value: SessionsGroupsState.defaultsConst }),
      loadGroups: async () => ({ ok: true as const, value: loaded[Math.min(reads++, 1)]! }),
      assignGroup: async () => ({ ok: true as const, value: true }),
      subscribeGroups: (onChanged: () => void) => {
        notify = onChanged
        return () => {}
      },
    }
    const { result } = renderHook(() => useSessionsGroups(ports))
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect([...result.current.groups]).toEqual([['session:parent', 'priority']])

    act(() => notify())
    await waitFor(() => expect(result.current.groups.get('session:fork')).toBe('priority'))
  })
})
