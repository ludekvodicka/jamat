import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SessionsOpResult } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { AppClientUiBridge, IpcResult } from '../../shared/appClientUiIpc'
import { TabClosePolicy } from './tabClosePolicy'

/** Only the one call this policy makes; nothing else of the bridge is reachable from here. */
class BridgeStub {
  readonly asked: string[] = []
  answer: IpcResult<SessionsOpResult> = { ok: true, value: { ok: true, value: undefined } }

  install(): void {
    (window as unknown as { appClient: unknown }).appClient = {
      sessions: {
        closePlain: (sessionId: string) => {
          this.asked.push(sessionId)
          return Promise.resolve(this.answer)
        },
      },
    } as unknown as AppClientUiBridge
  }
}

const paramsOf = (over: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ presentation: 'tab', kind: 'local', sessionId: 's-1', ...over })

describe('app-client-ui/renderer/shell/tabClosePolicy', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('lets any other panel close without asking anything', async () => {
    const bridge = new BridgeStub()
    bridge.install()

    expect(await TabClosePolicy.mayClose('fileViewer', paramsOf())).toBe(true)
    expect(bridge.asked).toEqual([])
  })

  // A terminal drawn as a SESSION has a row in the tree; closing its tab hides a panel and ends
  // nothing, so there is nothing to ask about.
  it('lets a session terminal close without asking anything', async () => {
    const bridge = new BridgeStub()
    bridge.install()

    expect(await TabClosePolicy.mayClose('terminal', paramsOf({ presentation: 'session' })))
      .toBe(true)
    expect(bridge.asked).toEqual([])
  })

  it('closes a plain tab once the library says the runtime is gone', async () => {
    const bridge = new BridgeStub()
    bridge.install()

    expect(await TabClosePolicy.mayClose('terminal', paramsOf())).toBe(true)
    expect(bridge.asked).toEqual(['s-1'])
  })

  // THE case this class was extracted for: it could not be driven while it was a private static in
  // the shell. A tab whose params carry no readable session id used to be closed on the strength of
  // `closePlain("undefined")` answering `not-found`, and the plain session whose only place on
  // screen was that tab went on running with no way back to it.
  it('keeps a plain tab whose params carry no session id, and asks nothing', async () => {
    const bridge = new BridgeStub()
    bridge.install()

    expect(await TabClosePolicy.mayClose('terminal', { presentation: 'tab' })).toBe(false)
    expect(bridge.asked).toEqual([])
  })

  // A remote terminal cannot be a plain tab - the codec refuses to write those params and refuses
  // to read them back - so params claiming both are unreadable, and unreadable keeps the tab.
  it('keeps a tab whose params claim a remote terminal in plain presentation', async () => {
    const bridge = new BridgeStub()
    bridge.install()

    expect(await TabClosePolicy.mayClose('terminal', {
      presentation: 'tab',
      target: { kind: 'remote', remoteEndpointId: 'e-1', sessionId: 's-1' },
    })).toBe(false)
    expect(bridge.asked).toEqual([])
  })

  // Nothing left to end: the record was promoted, or is already gone.
  it('closes the tab when the record is no longer a plain one', async () => {
    for (const code of ['not-found', 'invalid-spec'] as const) {
      const bridge = new BridgeStub()
      bridge.answer = { ok: true, value: { ok: false, code, detail: 'gone' } }
      bridge.install()

      expect(await TabClosePolicy.mayClose('terminal', paramsOf()), code).toBe(true)
    }
  })

  // A refusal it cannot act on leaves the tab where it is and says why: closing it would leave an
  // agent running where nobody could see it again.
  it('keeps the tab on a refusal it cannot act on, and reports the reason', async () => {
    const reported: string[] = []
    vi.spyOn(console, 'error').mockImplementation((message: string) => { reported.push(message) })
    const bridge = new BridgeStub()
    bridge.answer = { ok: true, value: { ok: false, code: 'host-unreachable', detail: 'no Host' } }
    bridge.install()

    expect(await TabClosePolicy.mayClose('terminal', paramsOf())).toBe(false)
    expect(reported).toEqual([
      '[app-client-ui] Closing the tab failed: host-unreachable: no Host',
    ])
  })

  it('keeps the tab when the call never reached the main process', async () => {
    const reported: string[] = []
    vi.spyOn(console, 'error').mockImplementation((message: string) => { reported.push(message) })
    const bridge = new BridgeStub()
    bridge.answer = { ok: false, error: 'no handler for sessions:close-plain' }
    bridge.install()

    expect(await TabClosePolicy.mayClose('terminal', paramsOf())).toBe(false)
    expect(reported).toEqual([
      '[app-client-ui] Closing the tab failed: no handler for sessions:close-plain',
    ])
  })
})
