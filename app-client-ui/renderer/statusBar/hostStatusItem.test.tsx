import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  HostPresence,
  HostStatusInfo,
  SessionsOpResult,
  SessionsSnapshot,
} from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { IpcResult } from '../../shared/appClientUiIpc'
import { SnapshotStore, type SnapshotStorePorts } from '../ipc/snapshotStore'
import { SessionsFixtures } from '../sessions/fixtures/sessionsFixtures'
import { type HostStatusPorts, HostStatusItem, HostStatusReading } from './hostStatusItem'

describe('app-client-ui/renderer/statusBar/hostStatusItem', () => {
  /** A snapshot of `null` is a read that never answers, which is the item's first second of life. */
  class Ports implements HostStatusPorts, SnapshotStorePorts<SessionsSnapshot> {
    readonly errors: string[] = []
    reads = 0
    starts = 0
    answer: IpcResult<SessionsOpResult> = { ok: true, value: { ok: true, value: undefined } }

    constructor(
      private readonly snapshot: SessionsSnapshot | null,
      private readonly readError: string | null = null,
    ) {}

    read(): Promise<IpcResult<SessionsSnapshot>> {
      this.reads += 1
      if (this.readError !== null)
        return Promise.resolve({ ok: false, error: this.readError })
      if (this.snapshot === null)
        return new Promise<IpcResult<SessionsSnapshot>>(() => undefined)
      return Promise.resolve({ ok: true, value: this.snapshot })
    }

    subscribe(): () => void {
      return () => undefined
    }

    reportError(message: string): void {
      this.errors.push(message)
    }

    startHost(): Promise<IpcResult<SessionsOpResult>> {
      this.starts += 1
      return Promise.resolve(this.answer)
    }
  }

  function withPresence(presence: HostPresence): SessionsSnapshot {
    const snapshot = SessionsFixtures.mixed()
    return { ...snapshot, host: { ...snapshot.host, presence } }
  }

  function startButton(container: HTMLElement): HTMLElement {
    const found = container.querySelector('.jamat-host-status__start')
    if (!(found instanceof HTMLElement))
      throw new Error(`The item drew no Start button: ${container.textContent}`)
    return found
  }

  const stops: (() => void)[] = []

  function mount(ports: Ports) {
    const snapshotStore = new SnapshotStore<SessionsSnapshot>('The sessions snapshot', ports)
    stops.push(snapshotStore.start())
    return render(<HostStatusItem ports={ports} snapshotStore={snapshotStore} />)
  }

  afterEach(() => {
    cleanup()
    for (const stop of stops.splice(0))
      stop()
    vi.useRealTimers()
  })

  /*
   * The store hands back a fresh object per revision, and a revision moves whenever anything about
   * any session does - several times a second while an agent works, in every open window. What this
   * item draws is three fields that almost never move, so it is derived once per CHANGE.
   */
  it('derives its line once for a burst of revisions that do not touch the Host', async () => {
    const base = SessionsFixtures.mixed()
    let revision = base.revision
    // A fresh document per read, with a moved revision and an untouched Host - which is what an
    // agent working produces: several a second, in every open window.
    const ports = new (class extends Ports {
      read(): Promise<IpcResult<SessionsSnapshot>> {
        revision += 1
        return Promise.resolve({ ok: true, value: { ...base, revision } })
      }
    })(base)
    const snapshotStore = new SnapshotStore<SessionsSnapshot>('The sessions snapshot', ports)
    stops.push(snapshotStore.start())
    const view = render(<HostStatusItem ports={ports} snapshotStore={snapshotStore} />)
    await waitFor(() => expect(view.container.textContent).toContain('4 live'))
    const derive = vi.spyOn(HostStatusReading, 'of')

    for (let step = 0; step < 10; step += 1)
      await act(async () => { await snapshotStore.refresh() })

    expect(revision).toBeGreaterThan(base.revision + 5)
    expect(view.container.textContent).toContain('4 live')
    expect(derive).not.toHaveBeenCalled()
    derive.mockRestore()
  })

  it('says nothing about a Host it has not read yet', () => {
    const { container } = mount(new Ports(null))

    expect(container.textContent).toBe('Host …')
    expect(container.querySelector('.jamat-host-status__start')).toBeNull()
  })

  it('reads out the version and the live count of a running Host', async () => {
    const { container } = mount(new Ports(SessionsFixtures.mixed()))

    await waitFor(() => expect(container.textContent).toBe('Host v2026.08.04.09.30 · 4 live'))
  })

  // A Start offered while a launch is in flight is a second Host, not a retry.
  it('offers no Start while a Host is already starting', async () => {
    const { container } = mount(new Ports(withPresence('starting')))

    await waitFor(() => expect(container.textContent).toBe('Host starting…'))
    expect(container.querySelector('.jamat-host-status__start')).toBeNull()
  })

  it('starts a Host nobody can reach', async () => {
    const ports = new Ports(SessionsFixtures.hostUnreachable())
    const { container } = mount(ports)
    await waitFor(() => expect(container.textContent).toContain('Host unreachable'))

    fireEvent.click(startButton(container))

    expect(ports.starts).toBe(1)
  })

  it('reports a refused start in the words the library used', async () => {
    const ports = new Ports(SessionsFixtures.hostUnreachable())
    ports.answer = { ok: true, value: { ok: false, code: 'spawn-failed', detail: 'no executable' } }
    const { container } = mount(ports)
    await waitFor(() => expect(container.textContent).toContain('Host unreachable'))

    fireEvent.click(startButton(container))

    await waitFor(() => expect(ports.errors).toEqual([
      'The Host could not be started: spawn-failed: no executable',
    ]))
  })

  it('reports a channel that never carried the request', async () => {
    const ports = new Ports(SessionsFixtures.hostUnreachable())
    ports.answer = { ok: false, error: 'main process is gone' }
    const { container } = mount(ports)
    await waitFor(() => expect(container.textContent).toContain('Host unreachable'))

    fireEvent.click(startButton(container))

    await waitFor(() => expect(ports.errors).toEqual([
      'The Host could not be started: main process is gone',
    ]))
  })

  it('shows the shared reader failure and retries that reader', async () => {
    vi.useFakeTimers()
    const ports = new Ports(null, 'main process is gone')
    const { container } = mount(ports)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
      for (const delay of [200, 400, 800, 1600])
        await vi.advanceTimersByTimeAsync(delay)
    })

    expect(container.textContent).toContain('Host status unavailable')
    expect(container.querySelector('.jamat-host-status')?.getAttribute('title'))
      .toContain('stopped refreshing')
    expect(ports.reads).toBe(5)

    fireEvent.click(startButton(container))

    expect(ports.reads).toBe(6)
    expect(container.textContent).toContain('Host …')
  })

  // The one derivation the bar and the Debug window's host section both read, so it is exhaustive
  // here or the two of them disagree about a presence neither was taught.
  it('refuses a presence it was never taught', () => {
    const host = { ...SessionsFixtures.mixed().host, presence: 'napping' as HostPresence }

    expect(() => HostStatusReading.of(host)).toThrow('Unknown host presence: "napping"')
  })

  it('offers a Start only where there is nothing to reach', () => {
    const readings = (['running', 'starting', 'unreachable'] as const)
      .map((presence): [HostPresence, boolean] => {
        const host: HostStatusInfo = { ...SessionsFixtures.mixed().host, presence }
        return [presence, HostStatusReading.of(host).startable]
      })

    expect(readings).toEqual([['running', false], ['starting', false], ['unreachable', true]])
  })
})
