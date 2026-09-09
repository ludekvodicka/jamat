import { act, cleanup, fireEvent } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RemoteControlSettingsFixtures } from './fixtures/remoteControlSettingsFixtures'
import { RemoteControlConnectionsTab } from './remoteControlConnectionsTab'

describe('app-client-ui/renderer/overlays/configuration/tabs/remoteControl/remoteControlConnectionsTab', () => {
  afterEach(() => {
    cleanup()
    RemoteControlSettingsFixtures.clearBridge()
  })

  function listTitles(view: { container: HTMLElement }): readonly (string | null)[] {
    return [...view.container.querySelectorAll('.jamat-configuration__section-title')]
      .map((node) => node.textContent)
  }

  /*
   * Both directions on one screen, because they answer the same question. The one this computer
   * dials is first: it is the one a person reads daily.
   */
  it('draws both directions, outbound first', async () => {
    const { view } = await RemoteControlSettingsFixtures
      .mount(<RemoteControlConnectionsTab onDirtyChange={vi.fn()} />)

    expect(listTitles(view)).toEqual(['Computers this one reaches', 'Computers allowed in'])
  })

  /*
   * The sessions tree draws connected computers and nothing else, so an offline one and everything
   * about why it is offline is read here or nowhere.
   */
  it('draws an offline computer with its diagnosis and its actions', async () => {
    const { view } = await RemoteControlSettingsFixtures.mount(
      <RemoteControlConnectionsTab onDirtyChange={vi.fn()} />,
      {
        snapshot: RemoteControlSettingsFixtures.snapshot({
          profiles: [RemoteControlSettingsFixtures.profile({
            status: 'offline',
            lastConnectedAt: Date.UTC(2026, 7, 30, 9, 0, 0),
            nextRetryAt: Date.UTC(2026, 7, 31, 9, 0, 0),
            applicationVersion: '2026.08.30.11.00',
          })],
        }),
      },
    )
    const row = view.container.querySelector('[data-profile="profile-a"]')

    expect(row?.textContent).toContain('Office PC')
    expect(row?.textContent).toContain('203.0.113.10:47150')
    expect(row?.textContent).toContain('offline')
    expect(row?.textContent).toContain('ECONNREFUSED 203.0.113.10:47150')
    expect(row?.textContent).toContain('2026.08.30.11.00')
    expect(RemoteControlSettingsFixtures.buttonNamed(view.container, 'Retry now')).toBeTruthy()
  })

  /*
   * Nothing is dialled until something asks, and this screen is one of the things that ask. Without
   * the hold every row would read idle, which is true and useless.
   */
  it('holds the connections open for as long as it is drawn', async () => {
    const { view, holds } = await RemoteControlSettingsFixtures
      .mount(<RemoteControlConnectionsTab onDirtyChange={vi.fn()} />)

    expect(holds).toEqual(['hold:network-settings'])

    view.unmount()

    expect(holds).toEqual(['hold:network-settings', 'release:network-settings'])
  })

  it('redraws a row from the snapshot that follows a command', async () => {
    const { view, push } = await RemoteControlSettingsFixtures
      .mount(<RemoteControlConnectionsTab onDirtyChange={vi.fn()} />)

    await push(RemoteControlSettingsFixtures.snapshot({
      profiles: [RemoteControlSettingsFixtures.profile({ status: 'idle' })],
    }))

    expect(view.container.querySelector('.jamat-configuration-remote__status')?.textContent)
      .toBe('idle, nothing is asking for it')
  })

  it('forgets a computer only after the second click, and edits its endpoint', async () => {
    const { view, calls } = await RemoteControlSettingsFixtures
      .mount(<RemoteControlConnectionsTab onDirtyChange={vi.fn()} />)

    fireEvent.click(RemoteControlSettingsFixtures.buttonNamed(view.container, 'Forget'))
    expect(calls).toEqual([])
    await act(async () => {
      fireEvent.click(RemoteControlSettingsFixtures.buttonNamed(view.container, 'Confirm forget'))
    })
    expect(calls).toEqual(['forgetProfile:profile-a'])

    fireEvent.click(RemoteControlSettingsFixtures.buttonNamed(view.container, 'Edit endpoint'))
    const row = view.container.querySelector('[data-profile="profile-a"]')
    if (!(row instanceof HTMLElement)) throw new Error('The screen drew no paired computer')
    fireEvent.change(
      RemoteControlSettingsFixtures.inputLabelled(row, 'Host'),
      { target: { value: '10.0.0.9' } },
    )
    await act(async () => {
      fireEvent.click(RemoteControlSettingsFixtures.buttonNamed(view.container, 'Save endpoint'))
    })

    expect(calls).toEqual(['forgetProfile:profile-a', 'setProfileEndpoint:profile-a:10.0.0.9:47150'])
  })

  /* An empty list says where one is added, because that is a different screen now. */
  it('says a computer is paired with nothing and names the screen that adds one', async () => {
    const { view } = await RemoteControlSettingsFixtures.mount(
      <RemoteControlConnectionsTab onDirtyChange={vi.fn()} />,
      { snapshot: RemoteControlSettingsFixtures.snapshot({ profiles: [] }) },
    )

    expect(view.container.textContent).toContain('No computer is paired with this one yet.')
    expect(view.container.textContent).toContain('Connect computer is where one is added.')
  })

  /*
   * R7: the target's only way to take access back, and the reason the row carries both ids - the
   * trust file is keyed by the pair, and the row names one endpoint of one computer.
   */
  it('revokes one allowed-in computer at the ids of its own row', async () => {
    const { view, calls } = await RemoteControlSettingsFixtures.mount(
      <RemoteControlConnectionsTab onDirtyChange={vi.fn()} />,
      {
        snapshot: RemoteControlSettingsFixtures.snapshot({
          inbound: [
            RemoteControlSettingsFixtures.inboundPeer({ connected: true }),
            RemoteControlSettingsFixtures.inboundPeer({
              remoteComputerId: 'computer-c',
              remoteEndpointId: 'endpoint-c',
              displayName: 'Tablet',
            }),
          ],
        }),
      },
    )
    const row = view.container.querySelector('[data-inbound="endpoint-c"]')
    if (!(row instanceof HTMLElement)) throw new Error('The screen drew no allowed-in computer')

    expect(row.textContent).toContain('Tablet')
    expect(row.textContent).toContain('fingerprint-b')
    await act(async () => {
      fireEvent.click(RemoteControlSettingsFixtures.buttonNamed(row, 'Revoke'))
    })

    expect(calls).toEqual(['revokeInbound:computer-c:endpoint-c'])
    expect(row.textContent).toContain('That computer may no longer reach this one.')
  })

  /** The one fact the trust file cannot hold: whether that computer is on the wire right now. */
  it('marks which allowed-in computers are connected right now', async () => {
    const { view } = await RemoteControlSettingsFixtures.mount(
      <RemoteControlConnectionsTab onDirtyChange={vi.fn()} />,
      {
        snapshot: RemoteControlSettingsFixtures.snapshot({
          inbound: [
            RemoteControlSettingsFixtures.inboundPeer({ connected: true }),
            RemoteControlSettingsFixtures.inboundPeer({
              remoteComputerId: 'computer-c',
              remoteEndpointId: 'endpoint-c',
            }),
          ],
        }),
      },
    )

    expect([...view.container.querySelectorAll('.jamat-configuration-remote__live')]
      .map((node) => node.textContent))
      .toEqual(['connected now', 'not connected'])
    expect(view.container
      .querySelector('[data-inbound="endpoint-b"] .jamat-configuration-remote__live')?.className)
      .toContain('--now')
  })

  it('says nobody may reach this computer when nobody has been allowed in', async () => {
    const { view } = await RemoteControlSettingsFixtures
      .mount(<RemoteControlConnectionsTab onDirtyChange={vi.fn()} />)

    expect(view.container.textContent).toContain('No computer may reach this one.')
    expect(view.container.querySelectorAll('[data-inbound]').length).toBe(0)
  })

  /* A section its owner cannot read is a section nothing may write over - in either direction. */
  it('warns about a damaged section and locks every write on both lists', async () => {
    const { view, calls } = await RemoteControlSettingsFixtures.mount(
      <RemoteControlConnectionsTab onDirtyChange={vi.fn()} />,
      {
        snapshot: RemoteControlSettingsFixtures.snapshot({
          sectionDamaged: true,
          inbound: [RemoteControlSettingsFixtures.inboundPeer()],
        }),
      },
    )

    expect(view.getByRole('alert').textContent).toContain('cannot read')
    expect(RemoteControlSettingsFixtures.buttonNamed(view.container, 'Retry now').disabled)
      .toBe(true)
    expect(RemoteControlSettingsFixtures.buttonNamed(view.container, 'Revoke').disabled).toBe(true)
    expect(calls).toEqual([])
  })
})
