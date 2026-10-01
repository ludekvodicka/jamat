import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { DtoAutoUpdateStatus } from '../../shared/electron/autoUpdate/common/autoUpdate.dto'
import type { AutoUpdateApi } from '../../shared/electron/autoUpdate/common/autoUpdateApi'
import { UpdateStatusItem } from './updateStatusItem'

describe('app-client-ui/renderer/statusBar/updateStatusItem', () => {
  /** A pull of `null` never answers, which is the item's first moment before main replies. */
  class FakeAutoUpdate implements AutoUpdateApi {
    readonly calls: string[]
    private readonly initial: DtoAutoUpdateStatus | null
    private listener: ((status: DtoAutoUpdateStatus) => void) | null

    constructor(initial: DtoAutoUpdateStatus | null) {
      this.calls = []
      this.initial = initial
      this.listener = null
    }

    status(): Promise<DtoAutoUpdateStatus> {
      return this.initial === null ? new Promise(() => undefined) : Promise.resolve(this.initial)
    }

    check(): Promise<void> {
      this.calls.push('check')
      return Promise.resolve()
    }

    install(): Promise<void> {
      this.calls.push('install')
      return Promise.resolve()
    }

    openReleasePage(): Promise<void> {
      this.calls.push('openReleasePage')
      return Promise.resolve()
    }

    onChanged(listener: (status: DtoAutoUpdateStatus) => void): () => void {
      this.listener = listener
      return () => {
        this.listener = null
      }
    }

    push(status: DtoAutoUpdateStatus): void {
      act(() => this.listener?.(status))
    }
  }

  const release = { version: '3.7.0', name: 'Jamat 3.7.0', date: '2026-10-01T08:00:00Z', notes: 'Shared updater' }

  function ready(): DtoAutoUpdateStatus {
    return { running: '3.6.0', mode: 'automatic', releasePage: true, state: { kind: 'ready', release } }
  }

  it('says nothing true before the first status, then draws the indicator in its bar class', () => {
    const api = new FakeAutoUpdate(null)
    const { container } = render(<UpdateStatusItem api={api} />)

    expect(container.textContent).toBe('Updates …')

    api.push({ running: '3.6.0', mode: 'off', releasePage: true, state: { kind: 'off', reason: 'Development run' } })

    const indicator = container.querySelector('.auto-update-indicator')
    expect(indicator?.classList.contains('jamat-update-status')).toBe(true)
    expect(indicator?.textContent).toBe('Updates off')
  })

  it('takes the status the pull answers with', async () => {
    render(<UpdateStatusItem api={new FakeAutoUpdate(ready())} />)

    expect(await screen.findByText('Version 3.7.0 ready')).toBeInTheDocument()
  })

  it('opens the panel outside the bar and runs its actions through the api', () => {
    const api = new FakeAutoUpdate(null)
    const { container } = render(<UpdateStatusItem api={api} />)
    api.push(ready())

    fireEvent.click(screen.getByText('Version 3.7.0 ready'))

    const dialog = screen.getByRole('dialog')
    expect(container.contains(dialog)).toBe(false)
    expect(dialog.closest('.jamat-update-panel')).not.toBeNull()
    expect(dialog.textContent).toContain('Shared updater')

    fireEvent.click(screen.getByText('View on GitHub'))
    fireEvent.click(screen.getAllByText('Restart and install')[0])
    fireEvent.click(screen.getByText('Close'))

    expect(api.calls).toEqual(['openReleasePage', 'install'])
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
