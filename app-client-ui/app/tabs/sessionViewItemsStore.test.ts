import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SessionViewItemsStore } from './sessionViewItemsStore'
import type { SessionOpen } from '../../shared/sessionViewItems'

const file = (openId: string): Omit<SessionOpen, 'sequence'> => ({ openId, sessionId: 'session', key: 'file', title: 'File',
  item: { kind: 'file', source: { kind: 'detected', sessionId: 'session', path: 'C:/source/file.md' } } })

describe('source semantic item catalog', () => {
  it('restores only semantic references and keeps retries distinct from intentional reopens', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jamat-items-'))
    try {
      const path = join(root, 'catalog.json')
      const store = new SessionViewItemsStore(path, vi.fn())
      const observed = vi.fn(() => { throw new Error('offline viewer') })
      store.subscribe(observed)
      const original = await store.record(file('intent'))
      expect(await store.record(file('intent'))).toEqual(original)
      await expect(store.record({ ...file('intent'), title: 'other' })).rejects.toThrow('another intent')
      await store.record(file('reopen'))
      await store.record({ openId: 'task', sessionId: 'session', key: 'task', title: 'Task', item: { kind: 'task', task: { kind: 'script', runId: 'run' } } })
      await store.record({ openId: 'review', sessionId: 'session', key: 'review', title: 'Review', item: { kind: 'review', reviewId: 'review', vcs: 'svn', scopeRoot: 'C:/source' } })
      const restarted = new SessionViewItemsStore(path, vi.fn())
      expect(restarted.page('session', { after: 0 }).items).toHaveLength(4)
      expect(restarted.page('other', { after: 0 }).items).toEqual([])
      expect(await restarted.record(file('intent'))).toEqual(original)
      const raw = await readFile(path, 'utf8')
      expect(raw).not.toMatch(/"(?:documentId|resourceId|grantId|viewId)"/)
      expect(observed).toHaveBeenCalledTimes(4)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('pages by bytes/count without losing pending reviews or replay authority after pruning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jamat-items-page-'))
    try {
      const path = join(root, 'catalog.json')
      const store = new SessionViewItemsStore(path, vi.fn())
      const original = await store.record(file('first'))
      await store.record({ openId: 'pending', sessionId: 'session', key: 'review', title: 'Review', item: { kind: 'review', reviewId: 'pending', vcs: 'git', scopeRoot: 'C:/repo' } })
      for (let i = 0; i < 513; i++) await store.record(file(`open-${i}`))
      const first = store.page('session', { after: 0 })
      expect(first.items[0].item.kind).toBe('review')
      expect(first.items).toHaveLength(64)
      const restored = new SessionViewItemsStore(path, vi.fn())
      expect(await restored.record(file('first'))).toEqual(original)
      expect(restored.page('session', { after: first.revision }).items).toEqual([])
      let page = first
      let count = page.items.length
      while (page.next !== null) {
        page = restored.page('session', { after: page.next, epoch: first.epoch, revision: first.revision })
        expect(page.revision).toBe(first.revision)
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(256 * 1024)
        count += page.items.length
      }
      expect(count).toBe(513)
      expect(() => restored.page('session', { after: 0, epoch: 'foreign' })).toThrow('replaced')
      const long = { ...file('long'), key: '界'.repeat(20_000) }
      await restored.record(long)
      await restored.record({ ...long, openId: 'long2' })
      await restored.record({ ...long, openId: 'long3' })
      expect(restored.page('session', { after: first.revision }).items).toHaveLength(2)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
