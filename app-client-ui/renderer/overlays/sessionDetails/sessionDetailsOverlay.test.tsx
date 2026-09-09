import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  SessionDetailsUpdate,
  SessionsSnapshot,
} from '../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { AppClientUiBridge } from '../../../shared/appClientUiIpc'
import { SnapshotStore } from '../../ipc/snapshotStore'
import { TerminalInputRegistry } from '../../shell/terminalInputRegistry'
import { SessionsFixtures } from '../../sessions/fixtures/sessionsFixtures'
import { SessionDetailsOverlay } from './sessionDetailsOverlay'

/** Only what the card reaches: one save channel, one clipboard write. */
class DetailsClientStub {
  readonly saved: { sessionId: string; update: SessionDetailsUpdate }[] = []
  readonly copied: string[] = []
  answer: Awaited<ReturnType<AppClientUiBridge['sessions']['setDetails']>> =
    { ok: true, value: { ok: true, value: { titleChanged: true, notifyAgent: null } } }

  /**
   * What the LIBRARY says is still owed to the agent after a save. Nothing here decides it any
   * more: whether there is anything to tell, and what, is a question about the record, and this
   * card's job is to type it and to say when it had nowhere to type it.
   */
  tellsCodex(): void {
    this.answer = {
      ok: true,
      value: { ok: true, value: { titleChanged: true, notifyAgent: { text: '/rename New name' } } },
    }
  }

  install(): void {
    const bridge = {
      sessions: {
        setDetails: (sessionId: string, update: SessionDetailsUpdate) => {
          this.saved.push({ sessionId, update })
          return Promise.resolve(this.answer)
        },
      },
      clipboard: {
        writeText: (text: string) => {
          this.copied.push(text)
          return Promise.resolve({ ok: true as const, value: undefined })
        },
      },
    }
    ;(window as unknown as { appClient: unknown }).appClient = bridge as unknown as
      Pick<AppClientUiBridge, 'sessions' | 'clipboard'>
  }
}

describe('app-client-ui/renderer/overlays/sessionDetails/sessionDetailsOverlay', () => {
  const stops: (() => void)[] = []

  afterEach(() => {
    cleanup()
    for (const stop of stops.splice(0)) stop()
    vi.restoreAllMocks()
    delete (window as unknown as { appClient?: unknown }).appClient
  })

  /** The card reads the snapshot the shell's store already holds, so the store arrives first. */
  async function mount(sessionId: string) {
    const client = new DetailsClientStub()
    client.install()
    const store = new SnapshotStore<SessionsSnapshot>('The sessions snapshot', {
      read: () => Promise.resolve({ ok: true as const, value: SessionsFixtures.mixed() }),
      subscribe: () => () => undefined,
      reportError: () => undefined,
    })
    stops.push(store.start())
    await waitFor(() => expect(store.current().snapshot).not.toBeNull())
    const inputs = new TerminalInputRegistry()
    const onClose = vi.fn()
    const view = render(
      <SessionDetailsOverlay
        request={{ requestId: 1, sessionId }}
        snapshot={store}
        inputs={inputs}
        onClose={onClose}
      />,
    )
    return { client, view, inputs, onClose }
  }

  function card(container: HTMLElement): HTMLElement {
    const found = container.querySelector('.jamat-session-details__card')
    if (!(found instanceof HTMLElement))
      throw new Error('The overlay drew no card')
    return found
  }

  function nameInput(container: HTMLElement): HTMLInputElement {
    const found = container.querySelector('.jamat-session-details__name')
    if (!(found instanceof HTMLInputElement))
      throw new Error('The overlay drew no name input')
    return found
  }

  function buttonNamed(container: HTMLElement, label: string): HTMLElement {
    const found = [...container.querySelectorAll('button')]
      .find((node) => node.textContent === label)
    if (!found)
      throw new Error(`The overlay drew no ${label} button`)
    return found
  }

  /** A swatch is a square with no text, so it is found by the name it announces. */
  function swatchNamed(container: HTMLElement, label: string): HTMLElement {
    const found = container.querySelector(
      `.jamat-session-details__swatches [aria-label="${label}"]`,
    )
    if (!(found instanceof HTMLElement))
      throw new Error(`The overlay drew no ${label} swatch`)
    return found
  }

  it('captures the session into the form and puts the caret on the selected name', async () => {
    const { view } = await mount('s-working')

    const input = nameInput(view.container)
    expect(input.value).toBe('Alpha worktree')
    expect(document.activeElement).toBe(input)
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe('Alpha worktree'.length)
    // No prefix on this title, so no chip stands before the input.
    expect(view.container.querySelector('.jamat-session-details__chip')).toBeNull()
    const meta = view.container.querySelector('.jamat-session-details__meta')
    expect(meta?.textContent).toContain('native-working')
    expect(meta?.textContent).toContain('AppJamatV3')
    expect(meta?.textContent).toContain('.worktrees/alpha')
    expect(meta?.textContent).toContain('Claude')
  })

  it('saves the three fields as one update and closes', async () => {
    const { client, view, onClose } = await mount('s-working')

    fireEvent.change(nameInput(view.container), { target: { value: 'Renamed' } })
    fireEvent.change(view.container.querySelector('.jamat-session-details__note') as HTMLElement, {
      target: { value: 'the point of it' },
    })
    fireEvent.click(swatchNamed(view.container, 'Teal'))
    fireEvent.click(buttonNamed(view.container, 'Save'))

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(client.saved).toEqual([{
      sessionId: 's-working',
      update: { name: 'Renamed', note: 'the point of it', color: 'teal' },
    }])
  })

  it('saves from Enter in the name field', async () => {
    const { client, view, onClose } = await mount('s-working')

    fireEvent.change(nameInput(view.container), { target: { value: 'Renamed' } })
    fireEvent.keyDown(nameInput(view.container), { key: 'Enter' })

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(client.saved).toHaveLength(1)
  })

  // The V1 behaviour: nothing changed means there is nothing to write, and the card just goes.
  it('closes without writing when nothing changed', async () => {
    const { client, view, onClose } = await mount('s-working')

    fireEvent.click(buttonNamed(view.container, 'Save'))

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(client.saved).toEqual([])
  })

  it('shows a refusal and stays open', async () => {
    const { client, view, onClose } = await mount('s-working')
    client.answer = {
      ok: true,
      value: { ok: false, code: 'invalid-spec', detail: 'The session name is empty' },
    }

    fireEvent.change(nameInput(view.container), { target: { value: 'Renamed' } })
    fireEvent.click(buttonNamed(view.container, 'Save'))

    await waitFor(() => expect(view.container.querySelector('.jamat-session-details__error')
      ?.textContent).toBe('invalid-spec: The session name is empty'))
    expect(onClose).not.toHaveBeenCalled()
    expect(card(view.container)).toBeTruthy()
    // The failed save released the card: the button reads Save again and takes another press.
    expect((buttonNamed(view.container, 'Save') as HTMLButtonElement).disabled).toBe(false)
  })

  // The channel's own failure goes through the same single branch as the library's refusal: the
  // reason lands on the card and the save button is released, never left stuck on Saving….
  it('shows a channel failure the same way and stays open', async () => {
    const { client, view, onClose } = await mount('s-working')
    client.answer = { ok: false, error: 'main process is gone' }

    fireEvent.change(nameInput(view.container), { target: { value: 'Renamed' } })
    fireEvent.click(buttonNamed(view.container, 'Save'))

    await waitFor(() => expect(view.container.querySelector('.jamat-session-details__error')
      ?.textContent).toBe('main process is gone'))
    expect(onClose).not.toHaveBeenCalled()
    expect((buttonNamed(view.container, 'Save') as HTMLButtonElement).disabled).toBe(false)
  })

  it('types what the library said into the live codex terminal after a successful save', async () => {
    const { client, view, inputs, onClose } = await mount('s-waiting')
    client.tellsCodex()
    const written: string[] = []
    inputs.register('s-waiting', {
      writable: () => true,
      write(data): boolean {
        written.push(data)
        return true
      },
      focus(): void {},
    })

    fireEvent.change(nameInput(view.container), { target: { value: 'New name' } })
    fireEvent.click(buttonNamed(view.container, 'Save'))

    await waitFor(() => expect(written).toEqual(['/rename New name', '\r']))
    expect(onClose).toHaveBeenCalledOnce()
  })

  /**
   * The record write landed and the keystrokes did not, which is a partial answer and has to read
   * as one. `submit` writes to a panel in THIS document, so it fails whenever the session has no tab
   * open in this window - the ordinary case for a rename started from the tree. It went to
   * `console.error` until 2026-08-21, so the card closed on what looked like a clean save while
   * Codex kept the old name in its own index.
   */
  it('says the agent was not told when the pipe finds no terminal, and stays open', async () => {
    const { client, view, onClose } = await mount('s-waiting')
    client.tellsCodex()

    fireEvent.change(nameInput(view.container), { target: { value: 'New name' } })
    fireEvent.click(buttonNamed(view.container, 'Save'))

    await waitFor(() => expect(view.container.querySelector('.jamat-session-details__error')
      ?.textContent).toContain('Codex was not told the new name'))
    // It says the save is done, because it is: only the propagation is missing.
    expect(view.container.querySelector('.jamat-session-details__error')?.textContent)
      .toContain('Saved.')
    expect(onClose).not.toHaveBeenCalled()
    // And the card is usable again rather than stuck mid-save.
    expect((buttonNamed(view.container, 'Save') as HTMLButtonElement).disabled).toBe(false)
  })

  it('closes on Escape and on a press on the backdrop', async () => {
    const escape = await mount('s-working')
    fireEvent.keyDown(card(escape.view.container), { key: 'Escape' })
    expect(escape.onClose).toHaveBeenCalledOnce()

    cleanup()
    const backdrop = await mount('s-working')
    const scrim = backdrop.view.container.querySelector('.jamat-session-details')
    if (!(scrim instanceof HTMLElement))
      throw new Error('The overlay drew no backdrop')
    fireEvent.mouseDown(scrim)
    expect(backdrop.onClose).toHaveBeenCalledOnce()
  })

  it('copies the session id the read-only row shows', async () => {
    const { client, view } = await mount('s-working')

    fireEvent.click(buttonNamed(view.container, 'Copy'))

    await waitFor(() => expect(client.copied).toEqual(['native-working']))
  })

  it('closes immediately when the session is gone from the snapshot', async () => {
    const { view, onClose } = await mount('s-missing')

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(view.container.querySelector('.jamat-session-details')).toBeNull()
  })
})
