import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { DtoAutoUpdateStatus } from '../../shared/electron/autoUpdate/common/autoUpdate.dto'
import type { AutoUpdateApi } from '../../shared/electron/autoUpdate/common/autoUpdateApi'
import { AppShellItems } from './appShellItems'
import { StatusBar } from './statusBar'

describe('app-client-ui/renderer/statusBar/statusBar', () => {
  it('separates every item but the first, and pushes the right group to the edge', () => {
    const { container } = render(
      <StatusBar
        left={[
          { key: 'version', node: <span>v1</span> },
          { key: 'identity', node: <span>identity: local</span> },
        ]}
        right={[{ key: 'channel', node: <span>development</span> }]}
      />,
    )

    // Two of the three items carry a separator: the first item on the bar has nothing to its left,
    // and the right group leads with one even though it opens its own half.
    expect(container.querySelectorAll('.jamat-status__separator').length).toBe(2)
    expect(container.querySelectorAll('.jamat-status__spacer').length).toBe(1)
    expect(screen.getByLabelText('Status').textContent).toBe('v1identity: localdevelopment')
  })

  it('renders an empty bar without a stray separator', () => {
    const { container } = render(<StatusBar left={[]} right={[]} />)

    expect(container.querySelectorAll('.jamat-status__separator').length).toBe(0)
  })

  /*
   * Layout only: the bar reads nothing of its own, so it must not TOUCH the bridge - a widget it
   * draws may, and that is the widget's business.
   *
   * Watched rather than absent. `expect(window.appClient).toBeUndefined()` was the precondition
   * before, and whether it holds depends on what another file in the same environment last did;
   * a proxy that records every read says the same thing about the bar itself.
   */
  it('reads nothing off the bridge to draw itself', () => {
    const reads: string[] = []
    const watched = new Proxy({}, {
      get: (_target, property) => {
        reads.push(String(property))
        return undefined
      },
    })
    Object.defineProperty(window, 'appClient', { value: watched, configurable: true })
    try {
      render(<StatusBar left={[{ key: 'version', node: <span>v1</span> }]} right={[]} />)
    } finally {
      delete (window as unknown as { appClient?: unknown }).appClient
    }

    expect(reads).toEqual([])
  })

  /*
   * The update item is the bar's one reader of the shared updater, and it reaches it through the
   * bridge's `autoUpdate` group rather than through the IpcResult table.
   */
  it('draws the update item from the bridge, beside the version', async () => {
    const status: DtoAutoUpdateStatus = {
      running: '3.6.0',
      mode: 'automatic',
      releasePage: true,
      state: { kind: 'current', checkedAt: 0 },
    }
    const autoUpdate: AutoUpdateApi = {
      status: () => Promise.resolve(status),
      check: () => Promise.resolve(),
      install: () => Promise.resolve(),
      openReleasePage: () => Promise.resolve(),
      onChanged: () => () => undefined,
    }
    Object.defineProperty(window, 'appClient', { value: { autoUpdate }, configurable: true })
    try {
      const appInfo = {
        appVersion: '3.6.0',
        platform: 'win32' as NodeJS.Platform,
        configDir: 'C:/config',
        configIdentity: 'identity',
        runtimeChannel: 'development' as const,
      }
      const { container } = render(
        <StatusBar left={AppShellItems.left(appInfo, window.appClient.autoUpdate, null, null)} right={[]} />,
      )

      expect(await screen.findByText('Up to date')).toBeInTheDocument()
      expect(container.querySelectorAll('.jamat-status__separator').length).toBe(1)
      expect(container.querySelector('.auto-update-indicator.jamat-update-status')).not.toBeNull()
    } finally {
      delete (window as unknown as { appClient?: unknown }).appClient
    }
  })
})
