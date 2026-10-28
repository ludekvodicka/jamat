import { afterEach, describe, expect, it } from 'vitest'

import type {
  TerminalFrame,
} from '../../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { AppClientUiBridge } from '../../../../shared/appClientUiIpc'
import type { TerminalTarget } from '../../../../shared/terminalTarget'
import { TerminalTransports } from './terminalTransport'
import { ControlBridgeFixture } from '../../../ipc/fixtures/controlBridgeFixture'

/**
 * The two channels, as the bridge would answer them: every call recorded, every answer settable.
 * What is under test is which channel a target chose and what it made of the answer, so the bridge
 * is the whole of the outside world here.
 */
class BridgeStub {
  readonly calls: { method: string; args: unknown[] }[] = []
  /**
   * What this machine's own side refuses with - the attach and the reopen alike, which is why the
   * code is a bare string here: the two channels refuse from different lists.
   */
  localRefusal: { code: string; detail: string } | null = null
  /** What the remote side refuses with - the peer's own code list, not the session manager's. */
  remoteRefusal: { code: string; detail: string } | null = null
  /** A call that never reached the main process at all: a channel failure, with no code. */
  channelFailure: string | null = null
  clipboard = 'held text'
  clipboardWritten = true
  private frame: ((attachId: string, frame: TerminalFrame) => void) | null = null
  private remoteFrame:
    ((endpointId: string, attachId: string, frame: TerminalFrame) => void) | null = null

  install(): void {
    const local = <T>(value: T): Promise<{ ok: true; value: T } | { ok: false; error: string }> =>
      this.channelFailure === null
        ? Promise.resolve({ ok: true as const, value })
        : Promise.resolve({ ok: false as const, error: this.channelFailure })
    const step = <T>(value: T): Promise<unknown> => {
      if (this.channelFailure !== null)
        return Promise.resolve({ ok: false as const, error: this.channelFailure })
      if (this.remoteRefusal !== null)
        return Promise.resolve({ ok: true as const, value: { ok: false, error: this.remoteRefusal } })
      return Promise.resolve({ ok: true as const, value: { ok: true, value } })
    }
    const record = (method: string, ...args: unknown[]): void => {
      this.calls.push({ method, args })
    }
    const bridge = {
      control: ControlBridgeFixture.routes({
        'sessions.reopen': {
          library: (body: { session: { sessionId: string } }) => {
            record('reopen', body.session.sessionId)
            return this.localRefusal === null
              ? local({ ok: true as const })
              : local({ ok: false as const, ...this.localRefusal })
          },
        },
      }),
      terminal: {
        attach: (attachId: string, spec: unknown) => {
          record('attach', attachId, spec)
          return this.localRefusal === null
            ? local({ ok: true as const })
            : local({ ok: false as const, ...this.localRefusal })
        },
        input: (attachId: string, data: string) => {
          record('input', attachId, data)
          return local(undefined)
        },
        resize: (attachId: string, cols: number, rows: number) => {
          record('resize', attachId, cols, rows)
          return local(undefined)
        },
        active: (attachId: string, active: boolean) => {
          record('active', attachId, active)
          return local(undefined)
        },
        detach: (attachId: string) => {
          record('detach', attachId)
          return local(undefined)
        },
        clipboardPaste: (attachId: string) => {
          record('clipboardPaste', attachId)
          return local({ kind: 'text', text: this.clipboard })
        },
        clipboardWrite: (attachId: string, text: string) => {
          record('clipboardWrite', attachId, text)
          return local(this.clipboardWritten)
        },
      },
      terminalMenu: {
        detect: (attachId: string, capture: unknown) => {
          record('detect', attachId, capture)
          return local({ requestId: 'request-1', detections: [] })
        },
      },
      clipboard: {
        writeText: (text: string) => {
          record('clipboardWriteText', text)
          return local(undefined)
        },
      },
      remote: {
        reopenSession: (endpointId: string, sessionId: string) => {
          record('remoteReopen', endpointId, sessionId)
          return step(undefined)
        },
        terminalAttach: (endpointId: string, attachId: string, spec: unknown) => {
          record('remoteAttach', endpointId, attachId, spec)
          return step({ attachId, sessionId: 's1' })
        },
        terminalInput: (endpointId: string, attachId: string, data: string) => {
          record('remoteInput', endpointId, attachId, data)
          return step({})
        },
        terminalResize: (endpointId: string, attachId: string, cols: number, rows: number) => {
          record('remoteResize', endpointId, attachId, cols, rows)
          return step({})
        },
        terminalActive: (endpointId: string, attachId: string, active: boolean) => {
          record('remoteActive', endpointId, attachId, active)
          return step({})
        },
        terminalDetach: (endpointId: string, attachId: string) => {
          record('remoteDetach', endpointId, attachId)
          return step({})
        },
        terminalClipboardPaste: (endpointId: string, attachId: string) => {
          record('remoteClipboardPaste', endpointId, attachId)
          return step({ kind: 'text', text: 'C:/remote/shot.png' })
        },
      },
      onTerminalFrame: (callback: (attachId: string, frame: TerminalFrame) => void) => {
        this.frame = callback
        return () => { this.frame = null }
      },
      onRemoteTerminalFrame: (
        callback: (endpointId: string, attachId: string, frame: TerminalFrame) => void,
      ) => {
        this.remoteFrame = callback
        return () => { this.remoteFrame = null }
      },
    }
    ;(window as unknown as { appClient: AppClientUiBridge })
      .appClient = bridge as unknown as AppClientUiBridge
  }

  serve(attachId: string, frame: TerminalFrame): void { this.frame?.(attachId, frame) }

  serveRemote(endpointId: string, attachId: string, frame: TerminalFrame): void {
    this.remoteFrame?.(endpointId, attachId, frame)
  }

  subscribed(): boolean { return this.frame !== null || this.remoteFrame !== null }

  methods(): string[] { return this.calls.map((call) => call.method) }
}

const localTarget: TerminalTarget = { kind: 'local', sessionId: 's1' }
const remoteTarget: TerminalTarget = { kind: 'remote', remoteEndpointId: 'e1', sessionId: 's1' }
const exitFrame: TerminalFrame = { type: 'terminal.exit', exitCode: 0 } as TerminalFrame

function install(): BridgeStub {
  const stub = new BridgeStub()
  stub.install()
  return stub
}

afterEach(() => {
  delete (window as unknown as { appClient?: AppClientUiBridge }).appClient
})

describe('app-client-ui/renderer/panels/terminal/terminalTransport', () => {
  describe('which channel a target chose', () => {
    it('sends every local call down the attach-bound channel', async () => {
      const stub = install()
      const attachment = TerminalTransports.of(localTarget).attachment('a1')

      expect(await attachment.attach({ cols: 80, rows: 24 })).toBeNull()
      attachment.input('x')
      attachment.resize(100, 40)
      attachment.setActive(true)
      attachment.clipboardWrite('copied')
      attachment.detach()

      expect(stub.methods())
        .toEqual(['attach', 'input', 'resize', 'active', 'clipboardWrite', 'detach'])
      expect(stub.calls[0]?.args).toEqual(['a1', { sessionId: 's1', size: { cols: 80, rows: 24 } }])
    })

    it('sends every remote call down the peer channel, with the endpoint in front', async () => {
      const stub = install()
      const attachment = TerminalTransports.of(remoteTarget).attachment('a1')

      expect(await attachment.attach(null)).toBeNull()
      attachment.input('x')
      attachment.resize(100, 40)
      attachment.setActive(true)
      attachment.detach()

      expect(stub.methods())
        .toEqual(['remoteAttach', 'remoteInput', 'remoteResize', 'remoteActive', 'remoteDetach'])
      expect(stub.calls[0]?.args).toEqual(['e1', 'a1', { sessionId: 's1', size: null }])
      expect(stub.calls[1]?.args).toEqual(['e1', 'a1', 'x'])
    })

    /*
     * The copy is the one call the two arms make differently on purpose. A local copy goes through
     * the attach, where main answers whether it landed; a remote one has nothing on the far side to
     * hold a clipboard against, so it goes to this machine's own.
     */
    it('copies out through the attach locally and through this machine remotely', () => {
      const stub = install()
      TerminalTransports.of(localTarget).attachment('a1').clipboardWrite('one')
      TerminalTransports.of(remoteTarget).attachment('a2').clipboardWrite('two')

      expect(stub.calls.map((call) => [call.method, call.args]))
        .toEqual([
          ['clipboardWrite', ['a1', 'one']],
          ['clipboardWriteText', ['two']],
        ])
    })

    it('refuses a target it does not know rather than treating it as this machine', () => {
      install()
      expect(() => TerminalTransports.of({ kind: 'proxied', sessionId: 's1' } as unknown as TerminalTarget))
        .toThrow(/Unknown terminal target/)
    })
  })

  /*
   * The peer protocol carries no detector, so the remote arm HAS none rather than one that answers
   * nothing. It does carry an image paste now, so both arms paste, and only the local agent shares
   * the clipboard of the person typing.
   */
  describe('what a transport honestly cannot do', () => {
    it('gives the local attach a clipboard paste and a detector, over a clipboard its agent shares', async () => {
      const stub = install()
      const attachment = TerminalTransports.of(localTarget).attachment('a1')

      expect(await attachment.clipboardPaste()).toEqual({ kind: 'text', text: 'held text' })
      await attachment.detect?.({ selection: null } as never)
      expect(stub.methods()).toEqual(['clipboardPaste', 'detect'])
      expect(attachment.agentSharesClipboard).toBe(true)
    })

    it('gives the remote attach a clipboard paste through its endpoint and no detector', async () => {
      const stub = install()
      const attachment = TerminalTransports.of(remoteTarget).attachment('a1')

      expect(await attachment.clipboardPaste()).toEqual({ kind: 'text', text: 'C:/remote/shot.png' })
      expect(stub.calls).toContainEqual({ method: 'remoteClipboardPaste', args: ['e1', 'a1'] })
      expect(attachment.detect).toBeUndefined()
      expect(attachment.agentSharesClipboard).toBe(false)
    })

    it('refuses a paste the channel refused, with the reason', async () => {
      const stub = install()
      stub.channelFailure = 'the window is gone'
      expect(await TerminalTransports.of(localTarget).attachment('a1').clipboardPaste())
        .toEqual({ kind: 'refused', detail: 'Paste failed: the window is gone' })
    })

    it('refuses a remote paste the other computer refused, with its sentence', async () => {
      const stub = install()
      stub.remoteRefusal = { code: 'forbidden', detail: 'update it' }
      expect(await TerminalTransports.of(remoteTarget).attachment('a1').clipboardPaste())
        .toEqual({ kind: 'refused', detail: 'Paste failed: update it' })
    })
  })

  describe('what a refused attach says', () => {
    it('carries the local code through, because it is what decides the restart button', async () => {
      const stub = install()
      stub.localRefusal = { code: 'not-live', detail: 'the session is installing' }

      expect(await TerminalTransports.of(localTarget).attachment('a1').attach(null))
        .toEqual({ detail: 'not-live: the session is installing', code: 'not-live' })
    })

    it('reads a remote code into the one the surface draws', async () => {
      const stub = install()
      stub.remoteRefusal = { code: 'not-found', detail: 'no such session' }

      expect(await TerminalTransports.of(remoteTarget).attachment('a1').attach(null))
        .toEqual({ detail: 'not-found: no such session', code: 'unknown-session' })
    })

    /* A peer that is merely not reachable right now is not a fact about the session. */
    it('says nothing at all about a peer that is only unavailable', async () => {
      const stub = install()
      stub.remoteRefusal = { code: 'unavailable', detail: 'not connected' }

      expect(await TerminalTransports.of(remoteTarget).attachment('a1').attach(null)).toBeNull()
    })

    it('leaves the code null where the call never reached anyone', async () => {
      const stub = install()
      stub.channelFailure = 'no handler'

      expect(await TerminalTransports.of(localTarget).attachment('a1').attach(null))
        .toEqual({ detail: 'no handler', code: null })
      expect(await TerminalTransports.of(remoteTarget).attachment('a1').attach(null))
        .toEqual({ detail: 'no handler', code: null })
    })

    it('throws on a peer code nobody has read yet', async () => {
      const stub = install()
      stub.remoteRefusal = { code: 'rate-limited', detail: 'later' }

      await expect(TerminalTransports.of(remoteTarget).attachment('a1').attach(null))
        .rejects.toThrow(/Unknown remote control error code/)
    })
  })

  describe('the frames one attach is subscribed to', () => {
    it('takes its own and leaves another attach alone', () => {
      const stub = install()
      const seen: TerminalFrame[] = []
      const off = TerminalTransports.of(localTarget).attachment('a1')
        .onFrame((frame) => seen.push(frame))

      stub.serve('a2', exitFrame)
      expect(seen).toHaveLength(0)
      stub.serve('a1', exitFrame)
      expect(seen).toEqual([exitFrame])

      off()
      expect(stub.subscribed()).toBe(false)
    })

    it('takes only the endpoint it attached to', () => {
      const stub = install()
      const seen: TerminalFrame[] = []
      TerminalTransports.of(remoteTarget).attachment('a1').onFrame((frame) => seen.push(frame))

      stub.serveRemote('e2', 'a1', exitFrame)
      stub.serveRemote('e1', 'a2', exitFrame)
      expect(seen).toHaveLength(0)
      stub.serveRemote('e1', 'a1', exitFrame)
      expect(seen).toEqual([exitFrame])
    })
  })

  describe('what the panel asks of it', () => {
    it('says which panel has the surfaces only this machine can answer', () => {
      install()
      expect(TerminalTransports.of(localTarget).localTools).toBe(true)
      expect(TerminalTransports.of(remoteTarget).localTools).toBe(false)
    })

    it('names the panel for a screen reader', () => {
      install()
      expect(TerminalTransports.of(localTarget).label).toBe('Terminal for session s1')
      expect(TerminalTransports.of(remoteTarget).label)
        .toBe('Remote terminal e1 for session s1')
    })

    it('starts the session again on whichever machine holds it', async () => {
      const stub = install()
      expect(await TerminalTransports.of(localTarget).reopen()).toBeNull()
      expect(await TerminalTransports.of(remoteTarget).reopen()).toBeNull()
      expect(stub.calls.map((call) => [call.method, call.args]))
        .toEqual([['reopen', ['s1']], ['remoteReopen', ['e1', 's1']]])
    })

    it('hands back the refusal sentence from either side', async () => {
      const stub = install()
      stub.localRefusal = { code: 'not-found', detail: 'no record' }
      stub.remoteRefusal = { code: 'conflict', detail: 'already running' }

      expect(await TerminalTransports.of(localTarget).reopen()).toBe('not-found: no record')
      expect(await TerminalTransports.of(remoteTarget).reopen()).toBe('conflict: already running')
    })
  })
})


it('uses an admitted source detector for remote attachments without changing clipboard upload', async () => {
  const bridge = new BridgeStub()
  bridge.install()
  const capture = { token: 'C:/source/file.ts:12', selection: null, contextText: '', fallbackToken: null }
  const calls: unknown[] = []
  const transport = TerminalTransports.of({ kind: 'remote', remoteEndpointId: 'peer', sessionId: 'session' }, async (value) => {
    calls.push(value)
    return { ok: true, value: { requestId: 'source-proof', detections: [] } }
  }).attachment('remote-attach')
  expect(await transport.detect!(capture)).toEqual({ ok: true, value: { requestId: 'source-proof', detections: [] } })
  expect(calls).toEqual([capture])
  expect(bridge.calls).toEqual([])
  expect(transport.agentSharesClipboard).toBe(false)
  expect(TerminalTransports.of({ kind: 'remote', remoteEndpointId: 'legacy', sessionId: 'session' }).attachment('legacy').detect).toBeUndefined()
})
