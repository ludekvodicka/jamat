import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AppClientUiBridge } from '../../shared/appClientUiIpc'
import { FileViewerFreshness, useFileViewerFreshness } from './useFileViewerFreshness'

class FreshnessHarness {
  static install() {
    const version = vi.fn(async () => ({
      ok: true as const,
      value: { ok: true as const, kind: 'unchanged' as const },
    }))
    ;(window as unknown as { appClient: AppClientUiBridge }).appClient = {
      fileViewer: { version },
    } as unknown as AppClientUiBridge
    return { version }
  }

  static async tick(times = 1): Promise<void> {
    for (let index = 0; index < times; index += 1)
      await act(async () => {
        vi.advanceTimersByTime(FileViewerFreshness.pollMillisecondsConst)
      })
  }
}

describe('app-client-ui/renderer/fileViewer/useFileViewerFreshness', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
    delete (window as unknown as { appClient?: unknown }).appClient
  })

  it('reloads once per disk version and keeps asking afterwards', async () => {
    vi.useFakeTimers()
    const { version } = FreshnessHarness.install()
    const reload = vi.fn()
    renderHook(() => useFileViewerFreshness('document-1', reload))

    await FreshnessHarness.tick()
    expect(reload).toHaveBeenCalledTimes(0)

    version.mockResolvedValue({
      ok: true,
      value: { ok: true, kind: 'changed', contentVersion: '24:2' },
    } as never)
    await FreshnessHarness.tick()
    expect(reload).toHaveBeenCalledTimes(1)

    // The document id does not move when a reload fails, and the same disk version must not be
    // retried on every tick for as long as the panel is open.
    await FreshnessHarness.tick(2)
    expect(reload).toHaveBeenCalledTimes(1)

    version.mockResolvedValue({
      ok: true,
      value: { ok: true, kind: 'changed', contentVersion: '24:3' },
    } as never)
    await FreshnessHarness.tick()
    expect(reload).toHaveBeenCalledTimes(2)
  })

  it('reports a file that is gone without reloading it', async () => {
    vi.useFakeTimers()
    const { version } = FreshnessHarness.install()
    const reload = vi.fn()
    const view = renderHook(() => useFileViewerFreshness('document-1', reload))

    version.mockResolvedValue({ ok: true, value: { ok: true, kind: 'missing' } } as never)
    await FreshnessHarness.tick()
    expect(view.result.current.missing).to.equal(true)
    expect(reload).toHaveBeenCalledTimes(0)

    version.mockResolvedValue({
      ok: true,
      value: { ok: true, kind: 'changed', contentVersion: '8:9' },
    } as never)
    await FreshnessHarness.tick()
    expect(view.result.current.missing).to.equal(false)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('asks nothing while there is no document and stops with the panel', async () => {
    vi.useFakeTimers()
    const { version } = FreshnessHarness.install()
    const view = renderHook(
      (documentId: string | null) => useFileViewerFreshness(documentId, vi.fn()),
      { initialProps: null as string | null },
    )

    await FreshnessHarness.tick(2)
    expect(version).toHaveBeenCalledTimes(0)

    view.rerender('document-1')
    await FreshnessHarness.tick()
    expect(version).toHaveBeenCalledTimes(1)

    view.unmount()
    await FreshnessHarness.tick(2)
    expect(version).toHaveBeenCalledTimes(1)
  })
})
