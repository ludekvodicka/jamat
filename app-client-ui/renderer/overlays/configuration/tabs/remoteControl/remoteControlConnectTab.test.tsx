import { act, cleanup, fireEvent } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RemoteControlSettingsFixtures } from './fixtures/remoteControlSettingsFixtures'
import { RemoteControlConnectTab } from './remoteControlConnectTab'

describe('app-client-ui/renderer/overlays/configuration/tabs/remoteControl/remoteControlConnectTab', () => {
  afterEach(() => {
    cleanup()
    RemoteControlSettingsFixtures.clearBridge()
  })

  function connectField(view: { container: HTMLElement }): HTMLTextAreaElement {
    const box = view.container.querySelector('.jamat-configuration-remote__bundle')
    if (!(box instanceof HTMLTextAreaElement)) throw new Error('The screen drew no connect field')
    return box
  }

  /*
   * One field takes either form. Which of the two it holds is the main process's to work out, so
   * the screen sends the text as typed and never parses it.
   */
  it('sends a pasted bundle and a typed address through the one connect field', async () => {
    const { view, calls } = await RemoteControlSettingsFixtures
      .mount(<RemoteControlConnectTab onDirtyChange={vi.fn()} />)

    fireEvent.change(connectField(view), { target: { value: '{"schemaVersion":1,"identity":{}}' } })
    await act(async () => {
      fireEvent.click(RemoteControlSettingsFixtures.buttonNamed(view.container, 'Connect'))
    })
    expect(calls).toEqual(['connectPairing:{"schemaVersion":1,"identity":{}}'])
    expect(connectField(view).value).toBe('')

    fireEvent.change(connectField(view), { target: { value: '10.0.0.2:47150' } })
    await act(async () => {
      fireEvent.click(RemoteControlSettingsFixtures.buttonNamed(view.container, 'Connect'))
    })
    expect(calls).toEqual([
      'connectPairing:{"schemaVersion":1,"identity":{}}',
      'connectPairing:10.0.0.2:47150',
    ])
  })

  /* R6: the two inputs pin that computer's key at different moments, and the screen says so. */
  it('names both input forms and what each one pins', async () => {
    const { view } = await RemoteControlSettingsFixtures
      .mount(<RemoteControlConnectTab onDirtyChange={vi.fn()} />)

    const hint = [...view.container.querySelectorAll('.jamat-configuration-remote__note')]
      .map((node) => node.textContent ?? '')
      .find((text) => text.includes('pinned'))

    expect(hint).toContain('bundle')
    expect(hint).toContain('host:port')
    expect(hint).toContain('fingerprint')
    expect(connectField(view).placeholder).toBe('Paste a pairing bundle, or type host:port')
  })

  /* The screen the computer lands on is not this one, so this one has to name it. */
  it('sends the reader to Remote connections for what happens next', async () => {
    const { view } = await RemoteControlSettingsFixtures
      .mount(<RemoteControlConnectTab onDirtyChange={vi.fn()} />)

    const next = [...view.container.querySelectorAll('.jamat-configuration-remote__note')]
      .map((node) => node.textContent ?? '')
      .find((text) => text.includes('Remote connections'))

    expect(next).toContain('allows this one in')
    expect(next).toContain('Retry now')
  })

  it('says nothing was typed rather than calling the main process with an empty field', async () => {
    const { view, calls } = await RemoteControlSettingsFixtures
      .mount(<RemoteControlConnectTab onDirtyChange={vi.fn()} />)

    await act(async () => {
      fireEvent.click(RemoteControlSettingsFixtures.buttonNamed(view.container, 'Connect'))
    })

    expect(view.getByRole('alert').textContent).toContain('or type its host:port')
    expect(calls).toEqual([])
  })

  it('says why a command was refused in this screen’s own words', async () => {
    const { view } = await RemoteControlSettingsFixtures.mount(
      <RemoteControlConnectTab onDirtyChange={vi.fn()} />,
      { answer: { ok: false, code: 'probe-failed', detail: 'ETIMEDOUT 10.0.0.2:47150' } },
    )

    fireEvent.change(connectField(view), { target: { value: '10.0.0.2:47150' } })
    await act(async () => {
      fireEvent.click(RemoteControlSettingsFixtures.buttonNamed(view.container, 'Connect'))
    })

    expect(view.getByRole('alert').textContent)
      .toContain('That address did not answer with pairing info')
    // A refused connect keeps what was typed: it is the thing to fix, not the thing to retype.
    expect(connectField(view).value).toBe('10.0.0.2:47150')
  })

  it('warns about a damaged section and locks the one field on it', async () => {
    const { view, calls } = await RemoteControlSettingsFixtures.mount(
      <RemoteControlConnectTab onDirtyChange={vi.fn()} />,
      { snapshot: RemoteControlSettingsFixtures.snapshot({ sectionDamaged: true }) },
    )

    expect(view.getByRole('alert').textContent).toContain('cannot read')
    expect(connectField(view).disabled).toBe(true)
    expect(RemoteControlSettingsFixtures.buttonNamed(view.container, 'Connect').disabled).toBe(true)
    expect(calls).toEqual([])
  })
})
