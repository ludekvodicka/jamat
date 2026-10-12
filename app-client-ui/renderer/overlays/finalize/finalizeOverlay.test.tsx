import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SessionsOpResult } from '../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { AppClientUiBridge, IpcResult } from '../../../shared/appClientUiIpc'
import { ControlBridgeFixture } from '../../ipc/fixtures/controlBridgeFixture'
import { SessionsFixtures } from '../../sessions/fixtures/sessionsFixtures'
import { FinalizeCatalog, type SessionFinalizeQuestionSpec } from './finalizeCatalog'
import { FinalizeAsks, type FinalizeOpenRequest } from './finalizeModel'
import { FinalizeOverlay, FinalizePorts } from './finalizeOverlay'

class FinalizeClientStub {
  readonly finalized: string[] = []
  readonly discarded: string[] = []
  /** Every Finish press: its choice, and `confirmed` when the person finished a working session anyway. */
  readonly pressed: string[] = []
  readonly remoteFinalized: { remoteEndpointId: string; sessionId: string; acknowledgeSetup?: string }[] = []
  /** The hash each local finalize carried, `null` for a press that carried none. */
  readonly acknowledged: (string | null)[] = []
  finalizeAnswer: IpcResult<SessionsOpResult> = { ok: true, value: { ok: true, value: undefined } }
  discardAnswer: IpcResult<SessionsOpResult> = { ok: true, value: { ok: true, value: undefined } }
  /** One answer per press; the last repeats. */
  pressAnswers: IpcResult<SessionsOpResult<{ sessionId: string; actionId: string | null }>>[] = [
    { ok: true, value: { ok: true, value: { sessionId: 's-dirty', actionId: 'action-1' } } },
  ]
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
  private pendingFinalize: Promise<IpcResult<SessionsOpResult>> | null = null
  private resolveFinalize: ((answer: IpcResult<SessionsOpResult>) => void) | null = null

  install(): void {
    const bridge = {
      control: {
        call: async (operation: string, body: { session: { sessionId: string }; acknowledgeSetup?: string; choice?: string; confirmWorking?: true }) => {
          const sessionId = body.session.sessionId
          if (operation === 'sessions.finalize') {
            this.finalized.push(sessionId)
            this.acknowledged.push(body.acknowledgeSetup ?? null)
            if (this.finalizeError !== null) throw this.finalizeError
            return ControlBridgeFixture.answerOf(operation, await (this.pendingFinalize ?? this.finalizeAnswer))
          } else if (operation === 'sessions.finishWorktree') {
            this.pressed.push(`${body.choice ?? '?'}${body.confirmWorking === true ? ' confirmed' : ''}`)
            if (body.choice === 'discard') this.discarded.push(sessionId)
            const answer = this.pressAnswers.length > 1 ? this.pressAnswers.shift()! : this.pressAnswers[0]
            return ControlBridgeFixture.answerOf(operation, answer)
          } else
            throw new Error(`No stub for ${operation}`)
        },
      },
      remote: {
        finalizeSession: (remoteEndpointId: string, sessionId: string, acknowledgeSetup?: string) => {
          this.remoteFinalized.push({
            remoteEndpointId,
            sessionId,
            ...(acknowledgeSetup === undefined ? {} : { acknowledgeSetup }),
          })
          if (this.remoteError !== null) return Promise.reject(this.remoteError)
          return Promise.resolve(this.remoteAnswer)
        },
      },
    }
    ;(window as unknown as { appClient: unknown }).appClient = bridge as unknown as
      Pick<AppClientUiBridge, 'control' | 'remote'>
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
        session: { glyph: 'ended', group: 'Sessions', note: null },
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

  it('asks for the agreement a local Finish was refused for, and repeats the press with its hash on Agree', async () => {
    const mounted = mount()
    mounted.client.finalizeAnswer = { ok: true, value: FinalizeOverlayTest.notAgreed() }

    fireEvent.keyDown(FinalizeOverlayTest.card(mounted.view.container), { key: 'Enter' })

    const block = await waitFor(() => FinalizeOverlayTest.agreement(mounted.view.container))
    expect([...block.querySelectorAll('li')].map((item) => item.textContent))
      .toEqual(['pnpm install', 'after tests (in packages/app): pnpm test'])
    expect(FinalizeOverlayTest.primary(mounted.view.container).textContent).toBe('Agree and finish')
    expect(mounted.view.container.querySelector('[role="alert"]')).toBeNull()
    expect(mounted.onClose).not.toHaveBeenCalled()
    // Enter never agrees to run commands.
    fireEvent.keyDown(FinalizeOverlayTest.card(mounted.view.container), { key: 'Enter' })
    expect(mounted.client.acknowledged).toEqual([null])

    mounted.client.finalizeAnswer = { ok: true, value: { ok: true, value: undefined } }
    fireEvent.click(FinalizeOverlayTest.primary(mounted.view.container))

    await waitFor(() => expect(mounted.onClose).toHaveBeenCalledOnce())
    expect(mounted.client.acknowledged).toEqual([null, 'hash-1'])
  })

  it('closes on Cancel of the agreement without a second press', async () => {
    const mounted = mount()
    mounted.client.finalizeAnswer = { ok: true, value: FinalizeOverlayTest.notAgreed() }
    fireEvent.click(FinalizeOverlayTest.primary(mounted.view.container))
    await waitFor(() => FinalizeOverlayTest.agreement(mounted.view.container))

    const cancel = [...mounted.view.container.querySelectorAll('.jamat-finalize__actions button')]
      .find((button) => button.textContent === 'Cancel')
    if (!(cancel instanceof HTMLButtonElement)) throw new Error('The agreement drew no Cancel')
    fireEvent.click(cancel)

    expect(mounted.onClose).toHaveBeenCalledOnce()
    expect(mounted.client.finalized).toEqual(['s-dirty'])
  })

  it('drops the agreement when another choice is made', async () => {
    const mounted = mount()
    mounted.client.finalizeAnswer = { ok: true, value: FinalizeOverlayTest.notAgreed() }
    fireEvent.click(FinalizeOverlayTest.primary(mounted.view.container))
    await waitFor(() => FinalizeOverlayTest.agreement(mounted.view.container))

    fireEvent.click(FinalizeOverlayTest.choice(mounted.view.container, 'Keep worktree'))

    expect(mounted.view.container.querySelector('.jamat-finalize__agreement')).toBeNull()
    expect(FinalizeOverlayTest.primary(mounted.view.container).textContent).toBe('Close')
  })

  it('carries the agreed hash to the paired computer that asked for it', async () => {
    const mounted = mount(FinalizeOverlayTest.remoteRequest())
    const refused = FinalizeOverlayTest.notAgreed()
    mounted.client.remoteAnswer = {
      ok: true,
      value: {
        protocol: 'appjamat-v3-control.v1',
        requestId: 'request-1',
        operation: 'sessions.finalize',
        operationId: 'operation-1',
        ok: false,
        error: {
          code: 'operation-failed',
          detail: refused.detail,
          data: { sourceCode: refused.code, setup: refused.setup },
        },
      },
    }

    fireEvent.click(FinalizeOverlayTest.primary(mounted.view.container))
    await waitFor(() => FinalizeOverlayTest.agreement(mounted.view.container))
    mounted.client.remoteAnswer = {
      ok: true,
      value: {
        protocol: 'appjamat-v3-control.v1',
        requestId: 'request-2',
        operation: 'sessions.finalize',
        operationId: 'operation-2',
        ok: true,
        value: { sessionId: 's-dirty' },
      },
    }
    fireEvent.click(FinalizeOverlayTest.primary(mounted.view.container))

    await waitFor(() => expect(mounted.onClose).toHaveBeenCalledOnce())
    expect(mounted.client.remoteFinalized).toEqual([
      { remoteEndpointId: 'endpoint-a', sessionId: 's-dirty' },
      { remoteEndpointId: 'endpoint-a', sessionId: 's-dirty', acknowledgeSetup: 'hash-1' },
    ])
  })

  it('throws if a defect tries to discard or keep through remote ports, and commits through the peer finalize', async () => {
    const mounted = mount()
    const ports = FinalizePorts.of({
      kind: 'remote',
      remoteEndpointId: 'endpoint-a',
      sessionId: 's-dirty',
    })

    expect(() => ports.finishWorktree('discard', {})).toThrow(/remote finalize ask cannot discard/)
    expect(() => ports.finishWorktree('keep', {})).toThrow(/remote finalize ask cannot keep/)
    await ports.finishWorktree('commit', { acknowledgeSetup: 'hash-2' })
    expect(mounted.client.remoteFinalized).toEqual([{ remoteEndpointId: 'endpoint-a', sessionId: 's-dirty', acknowledgeSetup: 'hash-2' }])
  })

  it('shows the activity, group and note of a live SVN session read-only, above its question', async () => {
    const session = SessionsFixtures.svnWorktrees().sessions.find((candidate) => candidate.sessionId === 's-svn')
    if (session?.worktree === undefined) throw new Error('The SVN worktree fixture is missing')
    const live = {
      ...session,
      life: 'live' as const,
      activity: 'working' as const,
      note: 'ready for review soon',
      worktree: { ...session.worktree, liveFinish: true as const },
    }
    const ask = FinalizeAsks.of(live, { kind: 'local', sessionId: 's-svn' }, 'local', 'Automation')
    if (ask === null) throw new Error('The live SVN fixture produced no finalize ask')
    const mounted = mount({ requestId: 1, ask })

    const facts = FinalizeOverlayTest.facts(mounted.view.container)
    expect(facts.compareDocumentPosition(mounted.view.container.querySelector('.jamat-choice__cards')!)
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(FinalizeOverlayTest.factsText(facts)).toEqual([
      ['Activity', '●working'],
      ['Group', 'Automation'],
      ['Note', 'ready for review soon'],
    ])
    expect(facts.querySelector('.jamat-finalize__glyph')).toHaveClass('jamat-finalize__glyph--paint-ok')
    expect(facts.querySelectorAll('button, input, select')).toHaveLength(0)

    fireEvent.click(FinalizeOverlayTest.primary(mounted.view.container))
    await waitFor(() => expect(mounted.onClose).toHaveBeenCalledOnce())
    expect(mounted.client.pressed).toEqual(['commit'])
  })

  it('leaves the note out when the session has none', () => {
    const ask = FinalizeOverlayTest.svnRequest().ask
    const mounted = mount({ requestId: 1, ask: { ...ask, session: { glyph: 'waiting', group: 'None', note: null } } })

    expect(FinalizeOverlayTest.factsText(FinalizeOverlayTest.facts(mounted.view.container))).toEqual([
      ['Activity', '◆waiting'],
      ['Group', 'None'],
    ])
  })

  // The dialog only takes the press; the action goes on in the client, so an accepted answer closes it.
  it('closes as soon as an SVN Finish is accepted, and asks once before finishing a session that still works', async () => {
    const request = FinalizeOverlayTest.svnRequest()
    const mounted = mount(request)
    mounted.client.pressAnswers = [
      { ok: true, value: { ok: false, code: 'session-working', detail: 'Session s-svn is still working (writing tests); finish it anyway, or wait until it is ready' } },
      { ok: true, value: { ok: true, value: { sessionId: 's-svn', actionId: 'action-1' } } },
    ]
    expect(mounted.view.container.querySelector('.jamat-finalize__note')?.textContent)
      .toBe('The Finish waits for you: the review ended without a commit')

    fireEvent.click(FinalizeOverlayTest.primary(mounted.view.container))
    await waitFor(() => expect(FinalizeOverlayTest.primary(mounted.view.container).textContent).toBe('Finish anyway'))
    expect(mounted.view.container.querySelector('[role="alert"]')?.textContent).toMatch(/still working \(writing tests\)/)
    expect(mounted.onClose).not.toHaveBeenCalled()
    // Enter never finishes a working session.
    fireEvent.keyDown(FinalizeOverlayTest.card(mounted.view.container), { key: 'Enter' })
    expect(mounted.client.pressed).toEqual(['commit'])

    fireEvent.click(FinalizeOverlayTest.primary(mounted.view.container))
    await waitFor(() => expect(mounted.onClose).toHaveBeenCalledOnce())
    expect(mounted.client.pressed).toEqual(['commit', 'commit confirmed'])
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
        session: { glyph: 'ended', group: 'Sessions', note: null },
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

  static svnRequest(): FinalizeOpenRequest {
    const session = SessionsFixtures.svnWorktrees().sessions.find((candidate) => candidate.sessionId === 's-svn')
    if (session === undefined) throw new Error('The SVN worktree fixture is missing')
    const waiting = {
      ...session,
      svnAction: { kind: 'finish' as const, stage: 'reviewing' as const, needs: 'the review ended without a commit',
        needsKind: 'review-cancelled' as const, review: null },
    }
    const ask = FinalizeAsks.of(waiting, { kind: 'local', sessionId: 's-svn' }, 'local', 'Sessions')
    if (ask === null) throw new Error('The SVN worktree fixture produced no finalize ask')
    return { requestId: 1, ask }
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
    const ask = FinalizeAsks.of(session, target, 'remote', 'Sessions')
    if (ask === null) throw new Error('The remote worktree fixture produced no finalize ask')
    return { requestId: 1, ask }
  }

  static notAgreed(): Extract<SessionsOpResult, { ok: false }> {
    return {
      ok: false,
      code: 'setup-not-acknowledged',
      detail: 'Q:/Apps/One asks to run 2 commands in its worktrees, and this machine has not agreed to them',
      setup: { commands: ['pnpm install', 'after tests (in packages/app): pnpm test'], hash: 'hash-1' },
    }
  }

  static agreement(container: HTMLElement): HTMLElement {
    const found = container.querySelector('.jamat-finalize__agreement')
    if (!(found instanceof HTMLElement)) throw new Error('The overlay drew no agreement')
    return found
  }

  static facts(container: HTMLElement): HTMLElement {
    const found = container.querySelector('.jamat-finalize__facts')
    if (!(found instanceof HTMLElement)) throw new Error('The overlay drew no session facts')
    return found
  }

  static factsText(facts: HTMLElement): string[][] {
    return [...facts.querySelectorAll('.jamat-finalize__fact')]
      .map((fact) => [fact.querySelector('dt')?.textContent ?? '', fact.querySelector('dd')?.textContent ?? ''])
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
