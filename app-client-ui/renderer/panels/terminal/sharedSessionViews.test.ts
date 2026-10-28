import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionOpen, SessionOpenPage } from '../../../shared/sessionViewItems'
import type { PanelSplitItem } from '../../widgets/tabs/panelSplit'
import { SharedSessionViews, type SharedSessionViewPorts } from './sharedSessionViews'

const local = { kind: 'local' as const, sessionId: 's' }
const remote = { kind: 'remote' as const, sessionId: 's', remoteEndpointId: 'peer' }
const entry = (sequence: number): SessionOpen => ({ sequence, openId: `intent-${sequence}`, sessionId: 's', key: `file-${sequence}`, title: 'file',
  item: { kind: 'file', source: { kind: 'workspace', sessionId: 's', path: `C:/source/${sequence}.txt` } } })
function memory() {
  const data = new Map<string, string>()
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) } }
}
function catalog() {
  let entries: SessionOpen[] = []
  const listeners = new Set<() => void>()
  const ports: SharedSessionViewPorts = { read: vi.fn(async (cursor) => ({ ok: true as const, value: {
    epoch: 'source-epoch', revision: entries.at(-1)?.sequence ?? 0, after: cursor.after, next: null, items: entries,
  } })), subscribe: (changed) => { listeners.add(changed); return () => { listeners.delete(changed) } } }
  return { ports, publish: (next: SessionOpen[]) => { entries = next; for (const changed of listeners) changed() } }
}
afterEach(() => vi.useRealTimers())

describe('SharedSessionViews', () => {
  it('projects an intentional open once in a second viewer, with no producer echo, dismissal replay or cross-endpoint consumption', async () => {
    vi.useFakeTimers()
    const source = catalog(), storage = memory(), first = vi.fn((_item: PanelSplitItem) => null), second = vi.fn((_item: PanelSplitItem) => null)
    const a = new SharedSessionViews(local, source.ports, storage, first, vi.fn(), vi.fn())
    const b = new SharedSessionViews(remote, source.ports, storage, second, vi.fn(), vi.fn())
    const stopA = a.start(), stopB = b.start()
    await vi.advanceTimersByTimeAsync(0)
    // The producer applies its user click and remembers the intent before sending it to source.
    first(SharedSessionViews.item(local, entry(1)))
    SharedSessionViews.remember(local, entry(1).openId, storage)
    source.publish([entry(1)])
    await vi.advanceTimersByTimeAsync(100)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    expect(second.mock.calls[0][0]).toMatchObject({ target: remote, source: { sessionId: 's', path: 'C:/source/1.txt' } })
    stopA(); stopB()
    const stopReload = new SharedSessionViews(remote, source.ports, storage, second, vi.fn(), vi.fn()).start()
    await vi.advanceTimersByTimeAsync(0)
    expect(second).toHaveBeenCalledTimes(1)
    source.publish([entry(1), entry(2)])
    await vi.advanceTimersByTimeAsync(100)
    expect(second).toHaveBeenCalledTimes(2)
    const other = vi.fn(() => null)
    const stopOther = new SharedSessionViews({ ...remote, remoteEndpointId: 'other' }, source.ports, storage, other, vi.fn(), vi.fn()).start()
    await vi.advanceTimersByTimeAsync(0)
    expect(other).toHaveBeenCalledTimes(2)
    stopReload(); stopOther()
  })

  it('persists overflow across reload and only retries it on the explicit button', async () => {
    vi.useFakeTimers()
    const source = catalog(), storage = memory(), changed = vi.fn(), apply = vi.fn((): string | null => 'Split is full')
    source.publish([entry(1)])
    const stop = new SharedSessionViews(remote, source.ports, storage, apply, changed, vi.fn()).start()
    await vi.advanceTimersByTimeAsync(0)
    expect(changed).toHaveBeenLastCalledWith([entry(1)])
    stop(); apply.mockReturnValue(null)
    const reload = new SharedSessionViews(remote, source.ports, storage, apply, changed, vi.fn())
    const stopReload = reload.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(apply).toHaveBeenCalledTimes(1)
    reload.openPending('intent-1')
    expect(apply).toHaveBeenCalledTimes(2)
    expect(changed).toHaveBeenLastCalledWith([])
    stopReload()
  })

  it.each(['revision', 'cursor', 'ownership'] as const)('refuses malformed %s pages before applying any item', async (fault) => {
    vi.useFakeTimers()
    const apply = vi.fn(() => null), report = vi.fn()
    const read = vi.fn(async ({ after }: { after: number }) => {
      const page: SessionOpenPage = after === 0
        ? { epoch: 'epoch', revision: 2, after: 0, next: 1, items: [entry(1)] }
        : { epoch: 'epoch', revision: fault === 'revision' ? 3 : 2, after, next: fault === 'cursor' ? 1 : null,
          items: [{ ...entry(2), sessionId: fault === 'ownership' ? 'foreign' : 's' }] }
      return { ok: true as const, value: page }
    })
    const stop = new SharedSessionViews(remote, { read, subscribe: () => () => {} }, memory(), apply, vi.fn(), report).start()
    await vi.advanceTimersByTimeAsync(0)
    expect(apply).not.toHaveBeenCalled()
    expect(report).toHaveBeenCalled()
    stop()
  })

  it('reports inaccessible or malformed consumption storage without throwing or reopening items', () => {
    for (const storage of [{ getItem: () => '{broken', setItem: vi.fn() }, { getItem: () => { throw new Error('Storage disabled') }, setItem: vi.fn() }]) {
      const source = catalog(), report = vi.fn(), apply = vi.fn(() => null)
      expect(() => new SharedSessionViews(remote, source.ports, storage, apply, vi.fn(), report).start()()).not.toThrow()
      expect(report).toHaveBeenCalled()
      expect(apply).not.toHaveBeenCalled()
    }
  })
})
