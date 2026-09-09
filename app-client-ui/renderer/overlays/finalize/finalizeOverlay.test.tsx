import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AppClientUiBridge } from '../../../shared/appClientUiIpc'
import { SessionsFixtures } from '../../sessions/fixtures/sessionsFixtures'
import { FinalizeCatalog, type SessionFinalizeQuestionSpec } from './finalizeCatalog'
import { FinalizeAsks, type FinalizeOpenRequest } from './finalizeModel'
import { FinalizeOverlay, FinalizePorts } from './finalizeOverlay'

class FinalizeClientStub {
  readonly finalized: string[] = []
  readonly discarded: string[] = []
  readonly remoteFinalized: { remoteEndpointId: string; sessionId: string }[] = []
  finalizeAnswer: Awaited<ReturnType<AppClientUiBridge['sessions']['finalize']>> =
    { ok: true, value: { ok: true, value: undefined } }
  discardAnswer: Awaited<ReturnType<AppClientUiBridge['sessions']['discardWorktree']>> =
    { ok: true, value: { ok: true, value: undefined } }
  remoteAnswer: Awaited<ReturnType<AppClientUiBridge['remote']['finalizeSession']>> = {
    ok: true,
    value: {
      protocol: 'appjamat-v3-control.v1',
      requestId: 'request-1',
      operation: 'sessions.finalize',
      operationId: null,
      ok: true,
      value: { sessionId: 's-dirty' },
    },
  }
  finalizeError: Error | null = null
  remoteError: Error | null = null
  private pendingFinalize: Promise<Awaited<ReturnType<
    AppClientUiBridge['sessions']['finalize']
  >>> | null = null
  private resolveFinalize: ((answer: Awaited<ReturnType<
    AppClientUiBridge['sessions']['finalize']
  >>) => void) | null = null

  install(): void {
    const bridge = {
      sessions: {
        finalize: (sessionId: string) => {
          this.finalized.push(sessionId)
          if (this.finalizeError !== null) return Promise.reject(this.finalizeError)
          return this.pendingFinalize ?? Promise.resolve(this.finalizeAnswer)
        },
        discardWorktree: (sessionId: string) => {
          this.discarded.push(sessionId)
          return Promise.resolve(this.discardAnswer)
        },
      },
      remote: {
        finalizeSession: (remoteEndpointId: string, sessionId: string) => {
          this.remoteFinalized.push({ remoteEndpointId, sessionId })
          if (this.remoteError !== null) return Promise.reject(this.remoteError)
          return Promise.resolve(this.remoteAnswer)
        },
      },
    }
    ;(window as unknown as { appClient: unknown }).appClient = bridge as unknown as
      Pick<AppClientUiBridge, 'sessions' | 'remote'>
  }

  holdFinalize(): void {
    this.pendingFinalize = new Promise((resolve) => {
      this.resolveFinalize = resolve
    })
  }

  finishFinalize(): void {
    if (this.resolveFinalize === null) throw new Error('No finalize call is being held')
    this.resolveFinalize(this.finalizeAnswer)
  }
}

describe('app-client-ui/renderer/overlays/finalize/finalizeOverlay', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    delete (window as unknown as { appClient?: unknown }).appClient
  })

  function mount(request: FinalizeOpenRequest = FinalizeOverlayTest.localRequest()) {
    const client = new FinalizeClientStub()
    client.install()
    const onClose = vi.fn()
    const view = render(<FinalizeOverlay request={request} onClose={onClose} />)
    return { client, onClose, view }
  }

  it('chooses Merge by default and submits it from Enter', async () => {
    const { client, onClose, view } = mount()

    expect(FinalizeOverlayTest.choice(view.container, 'Merge back'))
      .toHaveAttribute('aria-pressed', 'true')
    expect(FinalizeOverlayTest.primary(view.container).textContent).toBe('Merge')
    expect(document.activeElement).toBe(FinalizeOverlayTest.card(view.container))

    fireEvent.keyDown(FinalizeOverlayTest.card(view.container), { key: 'Enter' })

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(client.finalized).toEqual(['s-dirty'])
    expect(client.discarded).toEqual([])
  })

  it('changes the submit verb and operation when Discard is chosen', async () => {
    const { client, onClose, view } = mount()

    fireEvent.click(FinalizeOverlayTest.choice(view.container, 'Discard worktree'))
    expect(FinalizeOverlayTest.primary(view.container).textContent).toBe('Discard worktree')
    expect(FinalizeOverlayTest.primary(view.container))
      .toHaveClass('jamat-finalize__button--danger')
    fireEvent.click(FinalizeOverlayTest.primary(view.container))

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(client.finalized).toEqual([])
    expect(client.discarded).toEqual(['s-dirty'])
  })

  it('closes without calling a port when Keep is chosen', async () => {
    const { client, onClose, view } = mount()

    fireEvent.click(FinalizeOverlayTest.choice(view.container, 'Keep worktree'))
    expect(FinalizeOverlayTest.primary(view.container).textContent).toBe('Close')
    fireEvent.click(FinalizeOverlayTest.primary(view.container))

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(client.finalized).toEqual([])
    expect(client.discarded).toEqual([])
  })

  it.each(['merge-pending', 'merge-conflict'] as const)(
    'keeps the dialog open and releases it after a %s refusal',
    async (code) => {
      const mounted = mount()
      mounted.client.finalizeAnswer = {
        ok: true,
        value: { ok: false, code, detail: 'Resolve the worktree before trying again' },
      }

      fireEvent.click(FinalizeOverlayTest.primary(mounted.view.container))

      await waitFor(() => expect(mounted.view.container.querySelector('[role="alert"]')?.textContent)
        .toBe(`Merge back failed: ${code}: Resolve the worktree before trying again`))
      expect(mounted.onClose).not.toHaveBeenCalled()
      expect(FinalizeOverlayTest.primary(mounted.view.container)).not.toBeDisabled()
    },
  )

  it('releases a local rejection and reports it inside the dialog', async () => {
    const mounted = mount()
    mounted.client.finalizeError = new Error('local transport closed')

    fireEvent.click(FinalizeOverlayTest.primary(mounted.view.container))

    await waitFor(() => expect(mounted.view.container.querySelector('[role="alert"]')?.textContent)
      .toBe('Merge back failed: local transport closed'))
    expect(FinalizeOverlayTest.primary(mounted.view.container)).not.toBeDisabled()
    expect(mounted.onClose).not.toHaveBeenCalled()

    mounted.client.finalizeError = null
    fireEvent.click(FinalizeOverlayTest.primary(mounted.view.container))
    await waitFor(() => expect(mounted.onClose).toHaveBeenCalledOnce())
    expect(mounted.client.finalized).toEqual(['s-dirty', 's-dirty'])
  })

  it('releases a remote rejection and reports it inside the dialog', async () => {
    const mounted = mount(FinalizeOverlayTest.remoteRequest())
    mounted.client.remoteError = new Error('remote transport closed')

    fireEvent.click(FinalizeOverlayTest.primary(mounted.view.container))

    await waitFor(() => expect(mounted.view.container.querySelector('[role="alert"]')?.textContent)
      .toBe('Merge back failed: remote transport closed'))
    expect(FinalizeOverlayTest.primary(mounted.view.container)).not.toBeDisabled()
    expect(mounted.onClose).not.toHaveBeenCalled()
  })

  it('resumes at the first unfinished question after a refusal', async () => {
    const first: SessionFinalizeQuestionSpec = {
      id: 'first',
      order: 1,
      questionOf: () => null,
      perform: vi.fn(async () => ({
        ok: true as const,
        value: { ok: true as const, value: undefined },
      })),
    }
    let secondAttempt = 0
    const second: SessionFinalizeQuestionSpec = {
      id: 'second',
      order: 2,
      questionOf: () => null,
      perform: vi.fn(async () => {
        secondAttempt += 1
        if (secondAttempt === 1)
          return {
            ok: true as const,
            value: {
              ok: false as const,
              code: 'merge-pending' as const,
              detail: 'second question refused',
            },
          }
        return { ok: true as const, value: { ok: true as const, value: undefined } }
      }),
    }
    vi.spyOn(FinalizeCatalog, 'byId').mockImplementation((id) => {
      if (id === first.id) return first
      else if (id === second.id) return second
      else throw new Error(`Unknown test finalize question: ${JSON.stringify(id)}`)
    })
    const question = (title: string) => ({
      label: title,
      chosenDefault: 'run',
      choices: [{
        id: 'run',
        title,
        note: null,
        glyph: '•',
        submitLabel: title,
        danger: title === 'First',
      }],
    })
    const mounted = mount({
      requestId: 1,
      ask: {
        target: { kind: 'local', sessionId: 's-dirty' },
        scope: 'local',
        sessionTitle: 'Two questions',
        questions: [
          { specId: first.id, question: question('First') },
          { specId: second.id, question: question('Second') },
        ],
      },
    })

    expect(FinalizeOverlayTest.primary(mounted.view.container).textContent).toBe('Finish')
    expect(FinalizeOverlayTest.primary(mounted.view.container))
      .toHaveClass('jamat-finalize__button--danger')
    fireEvent.click(FinalizeOverlayTest.primary(mounted.view.container))
    await waitFor(() => expect(mounted.view.container.querySelector('[role="alert"]')?.textContent)
      .toBe('Second failed: merge-pending: second question refused'))
    expect(FinalizeOverlayTest.choice(mounted.view.container, 'First')).toBeDisabled()
    expect(FinalizeOverlayTest.primary(mounted.view.container).textContent).toBe('Second')
    expect(FinalizeOverlayTest.primary(mounted.view.container))
      .not.toHaveClass('jamat-finalize__button--danger')

    fireEvent.click(FinalizeOverlayTest.primary(mounted.view.container))
    await waitFor(() => expect(mounted.onClose).toHaveBeenCalledOnce())
    expect(first.perform).toHaveBeenCalledTimes(1)
    expect(second.perform).toHaveBeenCalledTimes(2)
  })

  it('closes on Escape and on the backdrop, and swallows Tab', () => {
    const escape = mount()
    expect(fireEvent.keyDown(FinalizeOverlayTest.card(escape.view.container), { key: 'Tab' }))
      .toBe(false)
    expect(escape.onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(FinalizeOverlayTest.card(escape.view.container), { key: 'Escape' })
    expect(escape.onClose).toHaveBeenCalledOnce()

    cleanup()
    const backdrop = mount()
    fireEvent.mouseDown(FinalizeOverlayTest.backdrop(backdrop.view.container))
    expect(backdrop.onClose).toHaveBeenCalledOnce()
  })

  it('allows no close or second submit while an operation is in flight', async () => {
    const { client, onClose, view } = mount()
    client.holdFinalize()

    fireEvent.click(FinalizeOverlayTest.primary(view.container))
    expect(FinalizeOverlayTest.primary(view.container)).toBeDisabled()
    fireEvent.keyDown(FinalizeOverlayTest.card(view.container), { key: 'Enter' })
    fireEvent.keyDown(FinalizeOverlayTest.card(view.container), { key: 'Escape' })
    fireEvent.mouseDown(FinalizeOverlayTest.backdrop(view.container))

    expect(client.finalized).toEqual(['s-dirty'])
    expect(onClose).not.toHaveBeenCalled()

    await act(async () => client.finishFinalize())
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
  })

  it('does not close after an operation resolves past unmount', async () => {
    const { client, onClose, view } = mount()
    client.holdFinalize()
    fireEvent.click(FinalizeOverlayTest.primary(view.container))

    view.unmount()
    await act(async () => client.finishFinalize())

    expect(onClose).not.toHaveBeenCalled()
  })

  it('derives the remote port from the target and never offers remote Discard', async () => {
    const request = FinalizeOverlayTest.remoteRequest()
    const { client, onClose, view } = mount(request)

    expect(FinalizeOverlayTest.maybeChoice(view.container, 'Discard worktree')).toBeNull()
    fireEvent.keyDown(FinalizeOverlayTest.card(view.container), { key: 'Enter' })

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(client.remoteFinalized).toEqual([{
      remoteEndpointId: 'endpoint-a',
      sessionId: 's-dirty',
    }])
    expect(client.finalized).toEqual([])
  })

  it('throws if a defect tries to discard through remote ports', () => {
    const ports = FinalizePorts.of({
      kind: 'remote',
      remoteEndpointId: 'endpoint-a',
      sessionId: 's-dirty',
    })

    expect(() => ports.discardWorktree()).toThrow(/remote finalize ask cannot discard/)
  })
})

class FinalizeOverlayTest {
  static localRequest(): FinalizeOpenRequest {
    return {
      requestId: 1,
      ask: {
        target: { kind: 'local', sessionId: 's-dirty' },
        scope: 'local',
        sessionTitle: 'Dirty worktree',
        questions: [{
          specId: 'worktree',
          question: {
            label: 'Worktree',
            chosenDefault: 'merge',
            choices: [
              {
                id: 'merge',
                title: 'Merge back',
                note: 'commits, merges and removes the worktree',
                glyph: '⇤',
                submitLabel: 'Merge',
              },
              {
                id: 'keep',
                title: 'Keep worktree',
                note: 'decide later',
                glyph: '—',
                submitLabel: null,
              },
              {
                id: 'discard',
                title: 'Discard worktree',
                note: 'throws the branch and directory away',
                glyph: '✕',
                submitLabel: 'Discard worktree',
                danger: true,
              },
            ],
          },
        }],
      },
    }
  }

  static remoteRequest(): FinalizeOpenRequest {
    const session = SessionsFixtures.stoppedWorktree().sessions
      .find((candidate) => candidate.sessionId === 's-dirty')
    if (session === undefined) throw new Error('The stopped worktree fixture is missing')
    const target = {
      kind: 'remote' as const,
      remoteEndpointId: 'endpoint-a',
      sessionId: session.sessionId,
    }
    const ask = FinalizeAsks.of(session, target, 'remote')
    if (ask === null) throw new Error('The remote worktree fixture produced no finalize ask')
    return { requestId: 1, ask }
  }

  static card(container: HTMLElement): HTMLElement {
    const found = container.querySelector('.jamat-finalize__card')
    if (!(found instanceof HTMLElement)) throw new Error('The overlay drew no card')
    return found
  }

  static backdrop(container: HTMLElement): HTMLElement {
    const found = container.querySelector('.jamat-finalize')
    if (!(found instanceof HTMLElement)) throw new Error('The overlay drew no backdrop')
    return found
  }

  static primary(container: HTMLElement): HTMLButtonElement {
    const found = container.querySelector('.jamat-finalize__button--primary')
    if (!(found instanceof HTMLButtonElement)) throw new Error('The overlay drew no submit button')
    return found
  }

  static choice(container: HTMLElement, title: string): HTMLButtonElement {
    const found = FinalizeOverlayTest.maybeChoice(container, title)
    if (found === null) throw new Error(`The overlay drew no ${JSON.stringify(title)} choice`)
    return found
  }

  static maybeChoice(container: HTMLElement, title: string): HTMLButtonElement | null {
    const found = [...container.querySelectorAll('.jamat-choice__card')]
      .find((candidate) => candidate.querySelector('.jamat-choice__card-title')?.textContent === title)
    return found instanceof HTMLButtonElement ? found : null
  }
}
