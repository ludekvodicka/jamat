import { describe, expect, it, vi } from 'vitest'
import type { ShellNotice } from '../../../lib-orchestrator/shared/shellPort.types'
import { SessionNotices } from './sessionNotices'

describe('SessionNotices', () => {
  it('releases its subscription once and rejects late events or new notices after disposal', async () => {
    let listener!: (id: string, event: 'clicked' | 'closed') => void
    const unsubscribe = vi.fn(), open = vi.fn(), notices: ShellNotice[] = []
    const owner = new SessionNotices({
      notify: notice => { notices.push(notice) },
      onNotice: next => { listener = next; return unsubscribe }, openPath: async () => {},
    }, () => null, open, () => {})
    owner.show({ sessionId: 's1', title: 'Work', body: 'Waiting' })
    owner.dispose()
    owner.dispose()
    listener(notices[0]!.id, 'clicked')
    listener(notices[0]!.id, 'closed')
    owner.show({ sessionId: 's2', title: 'Late', body: 'Waiting' })
    await Promise.resolve()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(open).not.toHaveBeenCalled()
    expect(notices).toHaveLength(1)
  })

  it('consumes a notice action once and reads the latest session title on click', async () => {
    let listener!: (id: string, event: 'clicked' | 'closed') => void
    const open = vi.fn(async () => ({ ok: true as const, value: { kind: 'workflow-opened' as const, panelId: 'p', windowId: 'w' } }))
    const notices: ShellNotice[] = []
    const owner = new SessionNotices({ notify: notice => { notices.push(notice) },
      onNotice: next => { listener = next; return () => {} }, openPath: async () => {},
    }, () => 'Current title', open, () => {})
    owner.show({ sessionId: 's1', title: 'Old title', body: 'Waiting' })
    listener(notices[0]!.id, 'clicked')
    listener(notices[0]!.id, 'clicked')
    await Promise.resolve()
    expect(open).toHaveBeenCalledExactlyOnceWith('s1', 'Current title')
    owner.dispose()
  })
})
