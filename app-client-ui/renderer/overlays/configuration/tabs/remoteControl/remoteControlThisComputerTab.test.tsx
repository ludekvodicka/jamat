import { act, cleanup, fireEvent } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RemoteControlSettingsFixtures } from './fixtures/remoteControlSettingsFixtures'
import { RemoteControlThisComputerTab } from './remoteControlThisComputerTab'

describe('app-client-ui/renderer/overlays/configuration/tabs/remoteControl/remoteControlThisComputerTab', () => {
  afterEach(() => {
    cleanup()
    RemoteControlSettingsFixtures.clearBridge()
  })

  /** What the file asks for is the form; what the listener is DOING is the line under it. */
  it('saves the listener the way the form has it and says what it is really doing', async () => {
    const onDirtyChange = vi.fn()
    const { view, calls } = await RemoteControlSettingsFixtures
      .mount(<RemoteControlThisComputerTab onDirtyChange={onDirtyChange} />)
    expect(view.container.querySelector('.jamat-configuration-remote__runtime')?.textContent)
      .toBe('Listener: listening on 0.0.0.0:47150')

    fireEvent.change(
      RemoteControlSettingsFixtures.inputLabelled(view.container, 'Bind address'),
      { target: { value: '127.0.0.1' } },
    )
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)
    await act(async () => {
      fireEvent.click(RemoteControlSettingsFixtures.buttonNamed(view.container, 'Save'))
    })

    expect(calls).toEqual([
      'saveListener:{"enabled":true,"bindHost":"127.0.0.1","port":47150,"advertisedHost":"10.0.0.2"}',
    ])
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)
  })

  /** Who this computer says it is, which is what the person at the other end reads back. */
  it('names this computer and its fingerprint', async () => {
    const { view } = await RemoteControlSettingsFixtures
      .mount(<RemoteControlThisComputerTab onDirtyChange={vi.fn()} />)

    expect(view.container.querySelector('.jamat-configuration-remote__facts')?.textContent)
      .toContain('fingerprint-here')
    expect(view.container.textContent).toContain('This PC')
  })

  it('copies the pairing bundle through the write-only bridge', async () => {
    const { view, calls } = await RemoteControlSettingsFixtures
      .mount(<RemoteControlThisComputerTab onDirtyChange={vi.fn()} />)

    await act(async () => {
      fireEvent.click(RemoteControlSettingsFixtures
        .buttonNamed(view.container, 'Copy pairing bundle'))
    })

    expect(calls).toEqual(['clipboard:{"schemaVersion":1}'])
    expect(view.container.textContent).toContain('The pairing bundle is on the clipboard.')
  })

  /* A bundle names the advertised endpoint, so one copied while nothing is bound sends the other
     computer at a port that answers nobody. */
  it('warns before a bundle is copied off a computer that is not listening', async () => {
    const { view } = await RemoteControlSettingsFixtures.mount(
      <RemoteControlThisComputerTab onDirtyChange={vi.fn()} />,
      {
        snapshot: RemoteControlSettingsFixtures.snapshot({
          listener: {
            configured: {
              enabled: false, bindHost: '0.0.0.0', port: 47_150, advertisedHost: '10.0.0.2',
            },
            runtime: { status: 'disabled' },
          },
        }),
      },
    )

    expect(view.container.querySelector('.jamat-configuration-remote__warning')?.textContent)
      .toContain('Nothing is listening here')
  })

  /* A section its owner cannot read is a section nothing may write over. */
  it('warns about a damaged section and locks every write on this screen', async () => {
    const { view, calls } = await RemoteControlSettingsFixtures.mount(
      <RemoteControlThisComputerTab onDirtyChange={vi.fn()} />,
      { snapshot: RemoteControlSettingsFixtures.snapshot({ sectionDamaged: true }) },
    )

    expect(view.getByRole('alert').textContent).toContain('cannot read')
    expect(RemoteControlSettingsFixtures.inputLabelled(view.container, 'Bind address').disabled)
      .toBe(true)
    expect(RemoteControlSettingsFixtures
      .buttonNamed(view.container, 'Copy pairing bundle').disabled).toBe(true)
    expect(calls).toEqual([])
  })

  /* Neither direction of the computer LIST is here: this screen is about this machine only. */
  it('draws no remote computer at all', async () => {
    const { view } = await RemoteControlSettingsFixtures.mount(
      <RemoteControlThisComputerTab onDirtyChange={vi.fn()} />,
      {
        snapshot: RemoteControlSettingsFixtures.snapshot({
          inbound: [RemoteControlSettingsFixtures.inboundPeer()],
        }),
      },
    )

    expect(view.container.querySelectorAll('[data-profile]').length).toBe(0)
    expect(view.container.querySelectorAll('[data-inbound]').length).toBe(0)
  })
})
