import { afterEach, describe, expect, it, vi } from 'vitest'

import type { TabTransferPayload } from '../../shared/tabTransfer'
import type { WorkspaceWindows } from '../shell/workspaceWindows'
import { TabTransferBroker } from './tabTransferBroker'
import { WorkspacePanelIndex } from './workspacePanelIndex'

class FakeWindows {
  readonly accepting = new Set(['source', 'target', 'other'])
  readonly published: { windowId: string; channel: string; args: unknown[] }[] = []

  acceptsWindow(windowId: string): boolean {
    return this.accepting.has(windowId)
  }

  publishToIfLive(windowId: string, channel: string, ...args: unknown[]): void {
    this.published.push({ windowId, channel, args })
  }

  asWindows(): WorkspaceWindows {
    return this as unknown as WorkspaceWindows
  }
}

describe('app-client-ui/app/tabs/tabTransferBroker', () => {
  afterEach(() => vi.useRealTimers())

  function panel(panelId = 'probe:1'): TabTransferPayload {
    return {
      panelId,
      key: 'probe',
      title: 'Probe',
      params: { serial: 1 },
      sessionId: null,
      presentation: null,
    }
  }

  function wiring(): {
    windows: FakeWindows
    index: WorkspacePanelIndex
    broker: TabTransferBroker
  } {
    const windows = new FakeWindows()
    const index = new WorkspacePanelIndex()
    return {
      windows,
      index,
      broker: new TabTransferBroker(windows.asWindows(), index),
    }
  }

  // The two guards that make a transfer transactional, and both of them stand AFTER an await:
  // `prepare` waits up to two seconds for the token to be registered, and the target window can
  // stop accepting inside that wait. `cancelClosingWindow` does not reach a transfer that is
  // still `registered` - it has no target yet - so these two checks are the only thing between a
  // closing window and a panel that ends up owned by nobody.
  it('refuses to prepare for a window that stopped accepting during the wait', async () => {
    const { windows, index, broker } = wiring()
    const payload = panel()
    index.claimOpen('source', payload)
    const preparing = broker.prepare('token', 'target')

    windows.accepting.delete('target')
    broker.start('token', payload, 'source')

    await expect(preparing).resolves.toBeNull()
    expect(index.ownerOf(payload.panelId)).toBe('source')
  })

  it('refuses to commit into a window that stopped accepting after it prepared', async () => {
    const { windows, index, broker } = wiring()
    const payload = panel()
    index.claimOpen('source', payload)
    broker.start('token', payload, 'source')
    expect(await broker.prepare('token', 'target')).not.toBeNull()

    windows.accepting.delete('target')

    expect(() => broker.commit('token', 'target'))
      .toThrow('The target window is not accepting transfers: target')
    expect(index.ownerOf(payload.panelId)).toBe('source')
  })

  it('commits a live transfer, changes ownership and tells the source to remove its copy', async () => {
    const { windows, index, broker } = wiring()
    const payload = panel()
    index.claimOpen('source', payload)
    index.setActivePanel('source', payload.panelId)

    broker.start('token', payload, 'source')
    expect(await broker.prepare('token', 'target')).toEqual({ token: 'token', panel: payload })
    broker.commit('token', 'target')

    expect(index.ownerOf(payload.panelId)).toBe('target')
    expect(index.visibleTerminalTargetKeys(new Set(['source']))).toEqual([])
    expect(windows.published).toEqual([
      { windowId: 'source', channel: 'tabs:transfer-out', args: [payload.panelId] },
    ])
  })

  it('waits for a drag token that arrives after prepare', async () => {
    const { index, broker } = wiring()
    const payload = panel()
    index.claimOpen('source', payload)

    const prepared = broker.prepare('token', 'target')
    broker.start('token', payload, 'source')

    await expect(prepared).resolves.toEqual({ token: 'token', panel: payload })
  })

  it('reserves one target and refuses self, another target and an unknown token', async () => {
    vi.useFakeTimers()
    const { index, broker } = wiring()
    const payload = panel()
    index.claimOpen('source', payload)
    broker.start('token', payload, 'source')

    await expect(broker.prepare('token', 'source')).resolves.toBeNull()
    await expect(broker.prepare('token', 'target')).resolves
      .toEqual({ token: 'token', panel: payload })
    await expect(broker.prepare('token', 'other')).resolves.toBeNull()
    const unknown = broker.prepare('unknown', 'target')
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(unknown).resolves.toBeNull()
  })

  it('rejects commit after the target renderer disappears and leaves the source owner', async () => {
    const { index, broker } = wiring()
    const payload = panel()
    index.claimOpen('source', payload)
    broker.start('token', payload, 'source')
    await broker.prepare('token', 'target')

    broker.rendererGone('target')

    expect(() => broker.commit('token', 'target')).toThrow(/not prepared/)
    expect(index.ownerOf(payload.panelId)).toBe('source')
  })

  it('recovers a prepared transfer after the source renderer disappears', async () => {
    const { windows, index, broker } = wiring()
    const payload = panel()
    index.claimOpen('source', payload)
    broker.start('token', payload, 'source')
    await broker.prepare('token', 'target')

    broker.rendererGone('source')
    index.releaseWindow('source')
    broker.commit('token', 'target')

    expect(index.ownerOf(payload.panelId)).toBe('target')
    expect(windows.published).toEqual([])
  })

  it('rejects sourceGone when a new source renderer has already reclaimed the panel', async () => {
    const { index, broker } = wiring()
    const payload = panel()
    index.claimOpen('source', payload)
    broker.start('token', payload, 'source')
    await broker.prepare('token', 'target')
    broker.rendererGone('source')
    index.releaseWindow('source')
    index.claimOpen('source', payload)

    expect(() => broker.commit('token', 'target')).toThrow(/Stale transfer owner/)
    expect(index.ownerOf(payload.panelId)).toBe('source')
  })

  it('drops a registered transfer when the source disappears before prepare', async () => {
    vi.useFakeTimers()
    const { index, broker } = wiring()
    const payload = panel()
    index.claimOpen('source', payload)
    broker.start('token', payload, 'source')
    broker.rendererGone('source')
    index.releaseWindow('source')

    const prepared = broker.prepare('token', 'target')
    await vi.advanceTimersByTimeAsync(2_000)

    await expect(prepared).resolves.toBeNull()
    expect(index.ownerOf(payload.panelId)).toBeNull()
  })

  it('cancels prepared transfers for an explicitly closing source or target', async () => {
    const sourceClose = wiring()
    const sourcePanel = panel('probe:source')
    sourceClose.index.claimOpen('source', sourcePanel)
    sourceClose.broker.start('source-token', sourcePanel, 'source')
    await sourceClose.broker.prepare('source-token', 'target')
    sourceClose.broker.cancelClosingWindow('source')
    expect(() => sourceClose.broker.commit('source-token', 'target')).toThrow(/not prepared/)
    expect(sourceClose.index.ownerOf(sourcePanel.panelId)).toBe('source')

    const targetClose = wiring()
    const targetPanel = panel('probe:target')
    targetClose.index.claimOpen('source', targetPanel)
    targetClose.broker.start('target-token', targetPanel, 'source')
    await targetClose.broker.prepare('target-token', 'target')
    targetClose.broker.cancelClosingWindow('target')
    expect(() => targetClose.broker.commit('target-token', 'target')).toThrow(/not prepared/)
    expect(targetClose.index.ownerOf(targetPanel.panelId)).toBe('source')
  })

  it('rejects a stale owner that moved after prepare', async () => {
    const { index, broker } = wiring()
    const payload = panel()
    index.claimOpen('source', payload)
    broker.start('token', payload, 'source')
    await broker.prepare('token', 'target')
    index.transfer('source', 'other', payload)

    expect(() => broker.commit('token', 'target')).toThrow(/Stale transfer owner/)
    expect(index.ownerOf(payload.panelId)).toBe('other')
  })

  it('reaps a canceled drag after its TTL', async () => {
    vi.useFakeTimers()
    const { index, broker } = wiring()
    const payload = panel()
    index.claimOpen('source', payload)
    broker.start('token', payload, 'source')

    await vi.advanceTimersByTimeAsync(30_000)
    const prepared = broker.prepare('token', 'target')
    await vi.advanceTimersByTimeAsync(2_000)

    await expect(prepared).resolves.toBeNull()
    expect(index.ownerOf(payload.panelId)).toBe('source')
  })

  /*
   * Both halves, and one of them NESTED. The old version read the lease alone and moved a top-level
   * field, which a one-level copy survives - and a one-level copy is exactly what the lease made and
   * what the index did not make at all. `params` is a document the renderer hands over, so a shared
   * value inside it would let the index and the lease see each other's edits.
   */
  it('keeps a defensive copy of payload parameters in the lease and index', async () => {
    const { index, broker } = wiring()
    const params = { serial: 1, sidebar: { width: 280 } }
    const payload = panel()
    payload.params = params
    index.claimOpen('source', payload)
    broker.start('token', payload, 'source')

    params.serial = 2
    ;(params.sidebar as { width: number }).width = 999

    const lease = await broker.prepare('token', 'target')
    expect(lease?.panel.params).toEqual({ serial: 1, sidebar: { width: 280 } })
    expect(index.snapshot().find((entry) => entry.panelId === payload.panelId)?.params)
      .toEqual({ serial: 1, sidebar: { width: 280 } })
  })
})
