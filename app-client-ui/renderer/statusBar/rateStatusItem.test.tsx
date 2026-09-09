import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  RateAgentId,
  RateMonitorSnapshot,
  RateProviderState,
} from '../../../lib-orchestrator/rateMonitor/rateMonitorApi.types'
import type { IpcResult } from '../../shared/appClientUiIpc'
import { SnapshotStore, type SnapshotStorePorts } from '../ipc/snapshotStore'
import { type RateStatusPorts, RateStatusItem } from './rateStatusItem'

describe('app-client-ui/renderer/statusBar/rateStatusItem', () => {
  /** A snapshot of `null` is a read that never answers, which is the item's first second of life. */
  class Ports implements RateStatusPorts, SnapshotStorePorts<RateMonitorSnapshot> {
    readonly errors: string[] = []
    reads = 0
    refreshes = 0
    answer: IpcResult<RateMonitorSnapshot> | null = null

    constructor(
      private readonly snapshot: RateMonitorSnapshot | null,
      private readonly readError: string | null = null,
    ) {}

    read(): Promise<IpcResult<RateMonitorSnapshot>> {
      this.reads += 1
      if (this.readError !== null)
        return Promise.resolve({ ok: false, error: this.readError })
      if (this.snapshot === null)
        return new Promise<IpcResult<RateMonitorSnapshot>>(() => undefined)
      return Promise.resolve({ ok: true, value: this.snapshot })
    }

    subscribe(): () => void {
      return () => undefined
    }

    reportError(message: string): void {
      this.errors.push(message)
    }

    refresh(): Promise<IpcResult<RateMonitorSnapshot>> {
      this.refreshes += 1
      if (this.answer !== null)
        return Promise.resolve(this.answer)
      if (this.snapshot === null)
        throw new Error('This test has no snapshot to answer a refresh with')
      return Promise.resolve({ ok: true, value: this.snapshot })
    }
  }

  /** One channel of the bridge, because one is all this widget ever reaches for. */
  class OpenedPages {
    readonly urls: string[] = []

    install(): void {
      const bridge = {
        fileViewer: {
          openExternal: (url: string) => {
            this.urls.push(url)
            return Promise.resolve({ ok: true as const, value: true })
          },
        },
      }
      ;(window as unknown as { appClient: unknown }).appClient = bridge
    }
  }

  function snapshotOf(
    claude: RateProviderState,
    codex: RateProviderState = { kind: 'never-read' },
  ): RateMonitorSnapshot {
    return { revision: 1, providers: { claude, codex } }
  }

  function okState(usedPercent: number): RateProviderState {
    return {
      kind: 'ok',
      fetchedAt: Date.now(),
      windows: [{ durationMinutes: 300, usedPercent, resetsAt: null }],
    }
  }

  function widget(container: HTMLElement): HTMLElement {
    const found = container.querySelector('.jamat-rate')
    if (!(found instanceof HTMLElement))
      throw new Error(`The bar drew no rate widget: ${container.textContent}`)
    return found
  }

  function line(container: HTMLElement): HTMLElement {
    const found = container.querySelector('.jamat-rate__line')
    if (!(found instanceof HTMLElement))
      throw new Error(`The widget drew no line: ${container.textContent}`)
    return found
  }

  const stops: (() => void)[] = []

  function mount(ports: Ports, agentId: RateAgentId = 'claude') {
    const store = new SnapshotStore<RateMonitorSnapshot>('The rate limits', ports)
    stops.push(store.start())
    return render(<RateStatusItem agentId={agentId} ports={ports} store={store} />)
  }

  afterEach(() => {
    cleanup()
    for (const stop of stops.splice(0))
      stop()
    vi.useRealTimers()
    delete (window as unknown as { appClient?: unknown }).appClient
  })

  it('draws no number before the first read answers', () => {
    const { container } = mount(new Ports(null))

    expect(container.textContent).toBe('usage …')
    expect(container.querySelector('.jamat-rate__line')).toBeNull()
  })

  /**
   * V1's line, for the provider whose terminal is the tab in front and no other: the letter, the
   * padded percentage, and a meter of ten characters.
   */
  it('draws the line of the agent it was given and nothing of the other one', async () => {
    const { container } = mount(new Ports(snapshotOf(
      {
        kind: 'ok',
        fetchedAt: Date.now(),
        windows: [
          { durationMinutes: 300, usedPercent: 42, resetsAt: null },
          { durationMinutes: 10_080, usedPercent: 12, resetsAt: null },
          { durationMinutes: 10_080, usedPercent: 87, resetsAt: null, model: 'opus' },
        ],
      },
      okState(90),
    )))

    await waitFor(() => expect(line(container).textContent)
      .toBe('S: 42% [████░░░░░░], W: 12% [█░░░░░░░░░], O: 87% [█████████░]'))
    // The scoped weekly is a segment of its own now, and the other provider is not this widget's.
    expect(container.textContent).not.toContain('90%')
    expect(widget(container).getAttribute('title')).toContain('Weekly (opus) 87%')
    expect(container.querySelector('.jamat-rate__line--dim')).toBeNull()
  })

  it('dims the last good windows of a provider whose read failed', async () => {
    const { container } = mount(new Ports(snapshotOf({
      kind: 'stale',
      fetchedAt: Date.now() - 60_000,
      windows: [{ durationMinutes: 300, usedPercent: 42, resetsAt: null }],
      reason: 'OAuth token expired',
    })))

    await waitFor(() => expect(container.textContent).toContain('S: 42%'))
    expect(container.querySelector('.jamat-rate__line--dim')).toBeTruthy()
    expect(widget(container).getAttribute('title')).toContain('OAuth token expired')
    expect(widget(container).getAttribute('title')).toContain('last read 1m 0s ago')
  })

  /**
   * The one state the narrowing does NOT hide. The bar drops both terminal widgets when the tab in
   * front is not an agent's, but a provider with no credentials still has a terminal in front of it,
   * and hiding the reading there would leave that user no way of ever learning it exists.
   */
  it('keeps a placeholder for a provider that is not configured', async () => {
    const { container } = mount(
      new Ports(snapshotOf(okState(42), { kind: 'unconfigured', reason: 'codex is not installed' })),
      'codex',
    )

    await waitFor(() => expect(line(container).textContent).toBe('-'))
    expect(container.querySelector('.jamat-rate__line--dim')).toBeTruthy()
    expect(widget(container).getAttribute('title'))
      .toBe('Codex usage is unavailable: codex is not installed')
  })

  it('asks for a fresh read when the line is clicked', async () => {
    const ports = new Ports(snapshotOf(okState(42)))
    const { container } = mount(ports)
    await waitFor(() => expect(container.textContent).toContain('S: 42%'))

    fireEvent.click(line(container))

    expect(ports.refreshes).toBe(1)
  })

  /** The arrow is a target of its own: a click meant for claude.ai must not also cost a read. */
  it('opens the Claude usage page from the arrow and reads nothing while doing it', async () => {
    const opened = new OpenedPages()
    opened.install()
    const ports = new Ports(snapshotOf(okState(42)))
    const { container } = mount(ports)
    await waitFor(() => expect(container.textContent).toContain('S: 42%'))

    const link = container.querySelector('.jamat-rate__link')
    if (!(link instanceof HTMLElement))
      throw new Error('The widget drew no usage link')
    fireEvent.click(link)

    expect(opened.urls).toEqual(['https://claude.ai/settings/usage'])
    expect(ports.refreshes).toBe(0)
  })

  it('draws no arrow for a provider that publishes no usage page', async () => {
    const { container } = mount(new Ports(snapshotOf(okState(42), okState(90))), 'codex')

    await waitFor(() => expect(container.textContent).toContain('S: 90%'))
    expect(container.querySelector('.jamat-rate__link')).toBeNull()
  })

  it('reports a refresh the channel never carried', async () => {
    const ports = new Ports(snapshotOf(okState(42)))
    ports.answer = { ok: false, error: 'main process is gone' }
    const { container } = mount(ports)
    await waitFor(() => expect(container.textContent).toContain('S: 42%'))

    fireEvent.click(line(container))

    await waitFor(() => expect(ports.errors).toEqual([
      'The rate limits could not be refreshed: main process is gone',
    ]))
  })

  it('shows the reader failure and retries that reader', async () => {
    vi.useFakeTimers()
    const ports = new Ports(null, 'main process is gone')
    const { container } = mount(ports)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
      for (const delay of [200, 400, 800, 1600])
        await vi.advanceTimersByTimeAsync(delay)
    })

    expect(container.textContent).toContain('usage unavailable')
    expect(widget(container).getAttribute('title')).toContain('stopped refreshing')
    expect(ports.reads).toBe(5)

    const retry = container.querySelector('.jamat-rate__retry')
    if (!(retry instanceof HTMLElement))
      throw new Error('The widget drew no Retry')
    fireEvent.click(retry)

    // The reader is what a Retry restarts, not the monitor: nothing was refused, nothing was read.
    expect(ports.reads).toBe(6)
    expect(ports.refreshes).toBe(0)
    expect(container.textContent).toContain('usage …')
  })
})
