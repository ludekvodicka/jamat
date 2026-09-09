import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { SessionsSnapshot } from '../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { IpcResult } from '../../../shared/appClientUiIpc'
import { SnapshotStore, type SnapshotStorePorts } from '../../ipc/snapshotStore'
import { SessionsFixtures } from '../../sessions/fixtures/sessionsFixtures'
import { useSessionsSnapshot } from './useSessionsSnapshot'

describe('app-client-ui/renderer/views/sessionsTree/useSessionsSnapshot', () => {
  class Ports implements SnapshotStorePorts<SessionsSnapshot> {
    subscriptions = 0
    private resolve: ((answer: IpcResult<SessionsSnapshot>) => void) | null = null

    read(): Promise<IpcResult<SessionsSnapshot>> {
      return new Promise((resolve) => {
        this.resolve = resolve
      })
    }

    subscribe(): () => void {
      this.subscriptions += 1
      return () => undefined
    }

    reportError(): void {}

    settle(snapshot: SessionsSnapshot): void {
      if (this.resolve === null)
        throw new Error('No sessions snapshot read is in flight')
      this.resolve({ ok: true, value: snapshot })
      this.resolve = null
    }
  }

  afterEach(() => cleanup())

  it('gives every hook the exact document owned by one store', async () => {
    const ports = new Ports()
    const store = new SnapshotStore<SessionsSnapshot>('The sessions snapshot', ports)
    const stop = store.start()
    const first = renderHook(() => useSessionsSnapshot(store))
    const second = renderHook(() => useSessionsSnapshot(store))
    const snapshot = SessionsFixtures.mixed()

    await act(async () => {
      ports.settle(snapshot)
      await Promise.resolve()
    })

    expect(ports.subscriptions).toBe(1)
    expect(first.result.current.snapshot).toBe(snapshot)
    expect(second.result.current.snapshot).toBe(snapshot)
    expect(first.result.current.error).toBe(second.result.current.error)

    stop()
  })
})
