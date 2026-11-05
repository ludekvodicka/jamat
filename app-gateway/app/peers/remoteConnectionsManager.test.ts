import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isDeepStrictEqual } from 'node:util'

import {
  type RemoteControlPeerApplicationMessage,
  type RemoteControlPeerCapability,
  type RemoteControlPeerIdentity,
  type RemoteControlPeerProfile,
} from '../../../lib-orchestrator/remoteControl/remoteControlPeerApi.types'
import type { RemoteControlHelloDto } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type { RemoteControlPeerTransport } from '../../../lib-orchestrator/remoteControl/remoteConnectionsApi.types'
import type {
  SessionsSnapshot,
  TerminalFrame,
} from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { TerminalGateway } from '../../../lib-orchestrator/sessionManager/terminalGateway'
import { ViewerBuffer } from '../terminals/viewerBuffer'
import { WindowPeers } from './windowPeers'
import { RemoteConnectionsManager } from './remoteConnectionsManager'
import { RemoteSessionSnapshots } from '../../../app-orchestrator/app/remoteControl/remoteSessionSnapshots'

describe('app-gateway/app/peers/remoteConnectionsManager', () => {
  it('redials edited addresses while preserving selection, geometry and active attachment intent for the same pinned identity', async t => {
    const profiles = [RemoteConnectionsManagerTest.profile('profile', 'target-computer', 'target-endpoint')]
    const h = new RemoteConnectionsManagerTest(profiles)
    t.after(() => h.manager.stop())
    h.manager.start()
    await h.manager.connectComputer('window', 'target-endpoint')
    await h.manager.selectSession('target-endpoint', 'session-a')
    const frames: TerminalFrame[] = []
    await h.manager.attachTerminal('target-endpoint', 'claim', { sessionId: 'session-a', size: { cols: 91, rows: 29 } }, frame => frames.push(frame))
    await h.manager.terminalActive('target-endpoint', 'claim', true)
    await h.manager.terminalResize('target-endpoint', 'claim', 120, 40)
    const old = h.transports[0]!, late = old.captureListeners()
    profiles[0] = { ...profiles[0]!, displayName: 'Edited', endpoint: { host: 'new-address', port: 47151 } }
    h.manager.reloadProfiles()
    await h.waitUntil(() => h.transports[1]?.activeRequests === 1)
    assert.equal(old.isOpen(), false)
    assert.equal(h.dialProfiles[1]?.endpoint.host, 'new-address')
    assert.deepEqual(h.manager.snapshot().outbound[0]?.selectedSessionIds, ['session-a'])
    assert.equal(h.transports[1]?.attachRequests, 1)
    const request = h.transports[1]!.sent.find(message => message.type === 'socket-request' && message.request.operation === 'terminal.attach')
    assert.partialDeepStrictEqual(request, { request: { attachId: 'claim', size: { cols: 120, rows: 40 } } })
    const count = frames.length
    late({ type: 'socket-response', response: { protocol: 'appjamat-v3-control.v1', type: 'terminal.frame', attachId: 'claim',
      frame: { type: 'terminal.status', status: 'lost', detail: 'obsolete' }, terminalOutputUntrusted: true } })
    assert.equal(frames.length, count)
    assert.partialDeepStrictEqual(await h.manager.terminalInput('target-endpoint', 'claim', 'new'), { ok: true })
  })

  it('keeps an inactive window claim out of geometry during buffer recovery beside an active viewer', async t => {
    const h = new RemoteConnectionsManagerTest()
    const output = new ViewerBuffer({ bytesOf: () => 1, send() {}, truncate() {}, resume() {} })
    const window = new WindowPeers('window', true, { outbound: () => h.manager, snapshot: () => h.manager.snapshot(),
      clipboard: async () => ({ ok: true, value: { kind: 'empty' } }), releaseMedia() {} }, output,
      { span: (_name, run) => run() }, message => { throw new Error(message) }, () => { throw new Error('Window failed') })
    t.after(() => { window.close(); output.close(); h.manager.stop() })
    h.manager.start()
    await h.manager.connectComputer('window', 'target-endpoint')
    await h.manager.selectSession('target-endpoint', 'session-a')
    await h.manager.attachTerminal('target-endpoint', 'active-owner', { sessionId: 'session-a', size: { cols: 150, rows: 50 } }, () => {})
    const context = { signal: new AbortController().signal, pending() {} }
    await window.invoke({ method: 'remote:terminal-attach', args: ['target-endpoint', 'hidden', { sessionId: 'session-a', size: { cols: 80, rows: 24 } }] }, context)
    await window.invoke({ method: 'remote:terminal-active', args: ['target-endpoint', 'hidden', false] }, context)
    const count = h.transports[0]!.sent.length
    window.truncate(); window.resume()
    await h.waitUntil(() => h.transports[0]!.attachRequests === 3 && h.transports[0]!.activeRequests >= 2)
    const recovery = h.transports[0]!.sent.slice(count)
    assert.partialDeepStrictEqual(recovery.find(message => message.type === 'socket-request' && message.request.operation === 'terminal.attach'), { request: { size: null } })
    assert.ok(recovery.some(message => message.type === 'socket-request' && message.request.operation === 'terminal.active' && !message.request.active))
    assert.equal(recovery.some(message => message.type === 'socket-request' && message.request.operation === 'terminal.resize'), false)
    assert.equal(recovery.some(message => message.type === 'socket-request' && 'attachId' in message.request && message.request.attachId === 'active-owner'), false)
  })

  it('restores an inactive delayed attachment without competing with another geometry owner', async t => {
    const profiles = [RemoteConnectionsManagerTest.profile('profile', 'target-computer', 'target-endpoint')]
    const h = new RemoteConnectionsManagerTest(profiles, { heldTimers: true })
    t.after(() => h.manager.stop())
    h.manager.start()
    await h.manager.connectComputer('window', 'target-endpoint')
    await h.manager.selectSession('target-endpoint', 'session-a')
    await h.manager.attachTerminal('target-endpoint', 'active-viewer', { sessionId: 'session-a', size: { cols: 150, rows: 50 } }, () => {})
    await h.manager.attachTerminal('target-endpoint', 'hidden-viewer', { sessionId: 'session-a', size: { cols: 80, rows: 24 } }, () => {}, false)
    const first = h.transports[0]!
    assert.partialDeepStrictEqual(first.sent.find(message => message.type === 'socket-request'
      && message.request.operation === 'terminal.attach' && message.request.attachId === 'hidden-viewer'), { request: { size: null } })
    assert.partialDeepStrictEqual(first.sent.at(-1), { request: { operation: 'terminal.active', active: false } })
    first.close()
    await h.settle()
    h.fireRetry()
    await h.waitUntil(() => h.transports[1]?.activeRequests === 1)
    const requests = h.transports[1]!.sent
    assert.partialDeepStrictEqual(requests.find(message => message.type === 'socket-request'
      && message.request.operation === 'terminal.attach' && message.request.attachId === 'hidden-viewer'), { request: { size: null } })
    assert.partialDeepStrictEqual(requests.find(message => message.type === 'socket-request'
      && message.request.operation === 'terminal.attach' && message.request.attachId === 'active-viewer'), { request: { size: { cols: 150, rows: 50 } } })
    assert.ok(requests.some(message => message.type === 'socket-request' && message.request.operation === 'terminal.active'
      && message.request.attachId === 'hidden-viewer' && message.request.active === false))
    await h.manager.terminalActive('target-endpoint', 'hidden-viewer', true)
    assert.partialDeepStrictEqual(h.transports[1]!.sent.at(-2), { request: { operation: 'terminal.resize', cols: 80, rows: 24 } })
  })

  for (const change of ['activate', 'resize-then-activate', 'activate-then-resize'] as const)
    it(`restores actual target geometry after ${change} while inactive reattach is pending`, async t => {
      const geometry: { cols: number; rows: number }[] = [], errors: unknown[] = []
      const target = new TerminalGateway({
        descriptorOf: () => ({ schemaVersion: 1, pid: 1, processStartedAt: 1, port: 1, token: 'test',
          protocol: { major: 1, minor: 2 }, capabilities: [], hostVersion: 'test', payloadHash: 'test',
          configIdentity: 'test', runtimeChannel: 'development', hostInstanceId: 'host', hostGeneration: 'one', startedAt: 1 }),
        leaseIdOf: () => 'lease', onError: message => { throw new Error(message) },
        activity: { userInput() {}, pendingInputHint() {} },
        socketFactory: deps => ({ connect() {}, close() {}, send(message) {
          if (message.type === 'terminal.attach') {
            if (message.cols !== undefined && message.rows !== undefined) geometry.push({ cols: message.cols, rows: message.rows })
            const size = geometry.at(-1) ?? { cols: 80, rows: 24 }
            deps.onFrame({ type: 'terminal.attached', writer: true, session: { runtimeSessionId: 'runtime',
              generation: 1, alive: true, ...size, outputSeq: 0, outputEpoch: 1, lastOutputAt: null, startedAt: 1 } })
          } else if (message.type === 'terminal.resize') geometry.push({ cols: message.cols, rows: message.rows })
          else if (message.type === 'terminal.detach') return
          else throw new Error(`Unexpected Host request: ${message.type}`)
        } }),
      })
      const h = new RemoteConnectionsManagerTest(undefined, { heldTimers: true })
      t.after(() => { h.manager.stop(); target.closeAll() })
      await target.publishRefs([{ sessionId: 'session-a', resolution: { ok: true, alive: true,
        ref: { hostInstanceId: 'host', runtimeSessionId: 'runtime', generation: 1 } } }])
      await target.attach('other-viewer', { sessionId: 'session-a', size: { cols: 150, rows: 50 } }, { source: 'remote', onFrame() {} })
      const bindTarget = (transport: RemoteConnectionsManagerTestTransport): void => {
        const send = transport.send.bind(transport)
        t.mock.method(transport, 'send', (message: RemoteControlPeerApplicationMessage) => {
          if (message.type !== 'socket-request') return send(message)
          const request = message.request
          let applied: Promise<unknown>
          switch (request.operation) {
            case 'terminal.attach':
              applied = target.attach(request.attachId, { sessionId: request.sessionId, size: request.size }, { source: 'remote', onFrame() {} }); break
            case 'terminal.resize': applied = target.resize(request.attachId, request.cols, request.rows); break
            case 'terminal.active': applied = target.setGeometryActive(request.attachId, request.active); break
            case 'terminal.detach': applied = Promise.resolve(target.detach(request.attachId)); break
            case 'events.subscribe': case 'terminal.input': case 'terminal.pasteImage': case 'terminal.pasteFile': return send(message)
            default: throw new Error(`Unexpected peer request: ${JSON.stringify(request)}`)
          }
          void applied.then(() => send(message)).catch(error => { errors.push(error); transport.close() })
          return true
        })
      }
      h.manager.start()
      await h.manager.connectComputer('window', 'target-endpoint')
      await h.manager.selectSession('target-endpoint', 'session-a')
      bindTarget(h.transports[0]!)
      await h.manager.attachTerminal('target-endpoint', 'hidden', { sessionId: 'session-a', size: { cols: 80, rows: 24 } }, () => {}, false)
      assert.deepEqual(geometry, [{ cols: 150, rows: 50 }])
      h.reconciled = false
      h.transports[0]!.close(); target.detach('hidden')
      await h.manager.connectComputer('window', 'target-endpoint')
      const replacement = h.transports[1]!
      bindTarget(replacement)
      let finish!: () => void
      replacement.attachGate = new Promise<void>(resolve => { finish = resolve })
      replacement.reconciled = true
      replacement.emitEvent(3)
      await h.waitUntil(() => replacement.sent.some(message => message.type === 'socket-request' && message.request.operation === 'terminal.attach'))
      assert.partialDeepStrictEqual(replacement.sent.find(message => message.type === 'socket-request' && message.request.operation === 'terminal.attach'), { request: { size: null } })
      if (change === 'resize-then-activate')
        assert.partialDeepStrictEqual(await h.manager.terminalResize('target-endpoint', 'hidden', 120, 40), { ok: false, error: { code: 'unavailable' } })
      else if (change !== 'activate' && change !== 'activate-then-resize') throw new Error('Unknown pending change')
      assert.partialDeepStrictEqual(await h.manager.terminalActive('target-endpoint', 'hidden', true), { ok: false, error: { code: 'unavailable' } })
      if (change === 'activate-then-resize')
        assert.partialDeepStrictEqual(await h.manager.terminalResize('target-endpoint', 'hidden', 120, 40), { ok: false, error: { code: 'unavailable' } })
      else if (change !== 'activate' && change !== 'resize-then-activate') throw new Error('Unknown pending change')
      assert.deepEqual(geometry, [{ cols: 150, rows: 50 }])
      finish()
      await h.waitUntil(() => replacement.activeRequests === 1)
      const restored = change === 'activate' ? { cols: 80, rows: 24 } : { cols: 120, rows: 40 }
      assert.deepEqual(geometry, [{ cols: 150, rows: 50 }, restored])
      assert.partialDeepStrictEqual(await h.manager.terminalActive('target-endpoint', 'hidden', true), { ok: true })
      assert.deepEqual(geometry, [{ cols: 150, rows: 50 }, restored])
      assert.deepEqual(errors, [])
    })

  for (const change of ['key', 'fingerprint', 'computer', 'config', 'channel', 'removal'] as const)
    it(`invalidates old selections and attachment authority on profile ${change}`, async t => {
      const profiles = [RemoteConnectionsManagerTest.profile('profile', 'target-computer', 'target-endpoint')]
      const h = new RemoteConnectionsManagerTest(profiles)
      t.after(() => h.manager.stop())
      h.manager.start()
      await h.manager.connectComputer('window', 'target-endpoint')
      await h.manager.selectSession('target-endpoint', 'session-a')
      const frames: TerminalFrame[] = []
      await h.manager.attachTerminal('target-endpoint', 'claim', { sessionId: 'session-a', size: null }, frame => frames.push(frame))
      const old = h.transports[0]!, profile = structuredClone(profiles[0]!)
      switch (change) {
        case 'key': profile.pinnedIdentity.publicKey += 'changed'; break
        case 'fingerprint': profile.pinnedIdentity.fingerprint += 'changed'; break
        case 'computer': profile.remoteComputerId += '-changed'; break
        case 'config': profile.configIdentity += '-changed'; break
        case 'channel': profile.runtimeChannel = 'production'; break
        case 'removal': break
        default: throw new Error('Unknown identity change')
      }
      profiles.splice(0, profiles.length, ...(change === 'removal' ? [] : [profile]))
      h.manager.reloadProfiles(); await h.settle()
      assert.equal(old.isOpen(), false)
      assert.equal(h.dials.length, 1)
      assert.deepEqual(h.manager.snapshot().outbound[0]?.selectedSessionIds ?? [], [])
      assert.ok(frames.some(frame => frame.type === 'terminal.status' && frame.status === 'lost'))
      assert.partialDeepStrictEqual(await h.manager.terminalInput('target-endpoint', 'claim', 'forbidden'), { ok: false })
    })

  it('rejects selection awaiting an old refresh and permits a fresh refresh after profile replacement', async t => {
    const profiles = [RemoteConnectionsManagerTest.profile('profile', 'target-computer', 'target-endpoint')]
    const h = new RemoteConnectionsManagerTest(profiles)
    t.after(() => h.manager.stop())
    h.manager.start(); await h.manager.connectComputer('window', 'target-endpoint')
    const old = h.transports[0]!
    let finish!: () => void
    old.listGate = new Promise(resolve => { finish = resolve })
    const pending = h.manager.selectSession('target-endpoint', 'late')
    profiles[0] = { ...profiles[0]!, endpoint: { host: 'edited', port: 47151 } }
    h.manager.reloadProfiles()
    await h.waitUntil(() => h.transports.length === 2 && h.manager.snapshot().outbound[0]?.status === 'connected')
    finish()
    assert.partialDeepStrictEqual(await pending, { ok: false, error: { code: 'unavailable' } })
    assert.deepEqual(h.manager.snapshot().outbound[0]?.selectedSessionIds, [])
    const current = h.transports[1]!, parent = h.manager.snapshot().outbound[0]!.sessions!.sessions[0]!
    current.additionalSessions = [{ ...parent, sessionId: 'late' }]
    assert.partialDeepStrictEqual(await h.manager.selectSession('target-endpoint', 'late'), { ok: true })
    assert.deepEqual(h.manager.snapshot().outbound[0]?.selectedSessionIds, ['late'])
  })

  it('redials a selected computer every few seconds until it answers, then reattaches its terminal', async () => {
    const harness = new RemoteConnectionsManagerTest(undefined, { heldTimers: true, random: 0.5 })
    harness.manager.start()
    await harness.manager.connectComputer('test', 'target-endpoint')
    await harness.waitUntil(() => harness.manager.snapshot().outbound[0]?.status === 'connected')
    assert.equal(harness.manager.snapshot().outbound[0]?.sessions?.revision, 1)
    await harness.manager.selectSession('target-endpoint', 'session-a')
    const frames: unknown[] = []
    assert.partialDeepStrictEqual(await harness.manager.attachTerminal(
      'target-endpoint',
      'attach-a',
      { sessionId: 'session-a', size: { cols: 80, rows: 24 } },
      (frame) => frames.push(frame),
    ), { ok: true })
    assert.equal(harness.transports[0]?.attachRequests, 1)
    assert.partialDeepStrictEqual(await harness.manager.terminalActive('target-endpoint', 'attach-a', true), { ok: true })
    assert.equal(harness.transports[0]?.activeRequests, 1)

    harness.refuseConnect = true
    harness.transports[0]?.close()
    await harness.settle()
    assert.deepEqual(harness.dials, ['target-endpoint'])
    assert.partialDeepStrictEqual(harness.manager.snapshot().outbound[0], {
      status: 'offline', nextRetryAt: harness.clock + 7_500,
    })
    assert.ok((frames).some(value => isDeepStrictEqual(value, {
      type: 'terminal.status',
      status: 'connecting',
      detail: 'Remote AppClientUI disconnected. Reconnecting automatically.',
    })))

    harness.fireRetry()
    await harness.waitUntil(() => harness.dials.length === 2
      && harness.manager.snapshot().outbound[0]?.status === 'offline')
    assert.equal(harness.manager.snapshot().outbound[0]?.nextRetryAt, harness.clock + 7_500)

    harness.refuseConnect = false
    harness.fireRetry()
    await harness.waitUntil(() => harness.transports.length === 2
      && harness.manager.snapshot().outbound[0]?.status === 'connected')
    await harness.waitUntil(() => harness.transports[1]?.activeRequests === 1)
    assert.equal(harness.transports[1]?.attachRequests, 1)
    assert.partialDeepStrictEqual(harness.manager.snapshot().outbound[0], { nextRetryAt: null, sessions: { revision: 2 } })
    assert.deepEqual(harness.timers.filter((timer) => timer.milliseconds === 7_500 && !timer.fired && !timer.cleared), [])
    harness.manager.stop()
  })

  it('stops redialling when the selection goes or the computer refuses this identity', async () => {
    const harness = new RemoteConnectionsManagerTest(undefined, { heldTimers: true, random: 0 })
    harness.manager.start()
    await harness.manager.connectComputer('dialog', 'target-endpoint')
    await harness.manager.selectSession('target-endpoint', 'session-a')
    harness.manager.releaseConnections('dialog')
    harness.transports[0]?.close()
    await harness.settle()
    const retry = harness.timers.find((timer) => timer.milliseconds === 5_000)
    assert.equal(retry?.cleared, false)
    await harness.manager.disconnectSessions('target-endpoint')
    assert.equal(retry?.cleared, true)
    assert.equal(harness.manager.snapshot().outbound[0]?.nextRetryAt, null)

    await harness.manager.connectComputer('dialog', 'target-endpoint')
    await harness.manager.selectSession('target-endpoint', 'session-a')
    harness.refuseConnect = true
    harness.refuseCode = 'forbidden'
    harness.transports[1]?.close()
    await harness.settle()
    harness.fireRetry()
    await harness.waitUntil(() => harness.dials.length === 3
      && harness.manager.snapshot().outbound[0]?.status === 'offline')
    assert.partialDeepStrictEqual(harness.manager.snapshot().outbound[0], { nextRetryAt: null, error: { code: 'forbidden' } })
    assert.deepEqual(harness.timers.filter((timer) => timer.milliseconds === 5_000 && !timer.fired && !timer.cleared), [])
    harness.manager.stop()
  })

  /*
   * The block a person copies to hand a session to a SECOND agent. Nothing is asked of the paired
   * computer: its sessions arrive whole on every refresh, so what is held is what the block is made
   * of - and the transcript is left out, because that file is on the other machine's disk.
   */
  it('writes down a paired session from what is held, and refuses what it does not hold', async () => {
    const harness = new RemoteConnectionsManagerTest()
    harness.manager.start()
    await harness.manager.connectComputer('test', 'target-endpoint')
    await harness.waitUntil(() => harness.manager.snapshot().outbound[0]?.status === 'connected')

    assert.deepEqual(harness.manager.sessionReference('target-endpoint', 'session-a'), {
      ok: true,
      value: {
        text: [
          'AppJamatV3 session',
          'reference version: 2',
          'computer: "Same name"',
          'route: remote',
          'controller config identity: "config-local-endpoint"',
          'controller channel: development',
          'remote endpoint id: "target-endpoint"',
          'target config identity: "config-target-endpoint"',
          'target channel: development',
          'session: "014 remote work"',
          'agent: codex',
          'agent session id: "native-remote-1"',
          'working directory: "D:/code/Alpha"',
          'jamat session id: "session-a"',
        ].join('\n'),
      },
    })
    assert.partialDeepStrictEqual(harness.manager.sessionReference('target-endpoint', 'session-gone'), { ok: false, code: 'not-found' })
    assert.partialDeepStrictEqual(harness.manager.sessionReference('endpoint-gone', 'session-a'), { ok: false, code: 'not-found' })
    harness.manager.stop()
  })

  /*
   * A paired peer is still another computer. Its answer used to be accepted after six field checks
   * and an assertion for the rest, so `sessions: [null]` travelled straight into the tree and threw
   * where the row was drawn - in the local window, from a remote machine's data.
   */
  it('refuses a sessions snapshot whose elements are not sessions', async () => {
    const harness = new RemoteConnectionsManagerTest()
    harness.manager.start()
    await harness.manager.connectComputer('test', 'target-endpoint')
    await harness.waitUntil(() => harness.manager.snapshot().outbound[0]?.status === 'connected')
    const transport = harness.transports[0]
    if (!transport) throw new Error('Transport was not created')

    transport.poisonSnapshot = true
    transport.snapshotRevision = 9
    transport.emitEvent(9)
    await harness.waitUntil(() =>
      harness.manager.snapshot().outbound[0]?.error?.detail === 'Remote sessions snapshot is invalid')

    assert.equal(harness.manager.snapshot().outbound[0]?.sessions?.revision, 1)
    harness.manager.stop()
  })

  /*
   * A refusal is the far end's own answer and it is final. The attachment used to stay behind it, so
   * the attachId was taken for good - every retry came back `already exists` - and each reconnect
   * re-opened a session that is not there.
   */
  it('frees the attachId when the far end refuses a terminal attach', async () => {
    const harness = new RemoteConnectionsManagerTest()
    harness.manager.start()
    await harness.manager.connectComputer('test', 'target-endpoint')
    await harness.waitUntil(() => harness.manager.snapshot().outbound[0]?.status === 'connected')
    const transport = harness.transports[0]
    if (!transport) throw new Error('Transport was not created')
    transport.refuseAttach = true
    await harness.manager.selectSession('target-endpoint', 'session-a')

    const refused = await harness.manager.attachTerminal(
      'target-endpoint',
      'attach-a',
      { sessionId: 'session-a', size: null },
      () => {},
    )
    assert.partialDeepStrictEqual(refused, { ok: false, error: { code: 'not-found' } })

    transport.refuseAttach = false
    assert.partialDeepStrictEqual(await harness.manager.attachTerminal(
      'target-endpoint',
      'attach-a',
      { sessionId: 'session-a', size: null },
      () => {},
    ), { ok: true })
    harness.manager.stop()
  })

  /*
   * The whole point of dialling on demand: starting the app reaches nobody. Before this, every
   * paired computer was dialled at boot and held open for the life of the process, so the sessions
   * tree drew a live row for a machine nobody had asked about.
   */
  it('dials nothing until something asks', async () => {
    const harness = new RemoteConnectionsManagerTest()
    harness.manager.start()
    await new Promise<void>((resolve) => setTimeout(resolve, 20))

    assert.deepEqual(harness.dials, [])
    assert.partialDeepStrictEqual(harness.manager.snapshot().outbound[0], {
      remoteEndpointId: 'target-endpoint',
      status: 'idle',
    })

    await harness.manager.connectComputer('a-screen', 'target-endpoint')
    await harness.waitUntil(() => harness.manager.snapshot().outbound[0]?.status === 'connected')
    assert.deepEqual(harness.dials, ['target-endpoint'])
    harness.manager.stop()
  })

  /* Two screens open at once are two holds, and the second closing is what hangs up. */
  it('hangs up once the last holder lets go, and not before', async () => {
    const harness = new RemoteConnectionsManagerTest()
    harness.manager.start()
    await harness.manager.connectComputer('one', 'target-endpoint')
    await harness.manager.connectComputer('two', 'target-endpoint')
    await harness.waitUntil(() => harness.manager.snapshot().outbound[0]?.status === 'connected')

    harness.manager.releaseConnections('one')
    await harness.settle()
    assert.equal(harness.manager.snapshot().outbound[0]?.status, 'connected')

    harness.manager.releaseConnections('two')
    await harness.settle()

    assert.partialDeepStrictEqual(harness.manager.snapshot().outbound[0], {
      status: 'idle',
      error: null,
      // Kept: it is history, and the settings row is where a person reads it.
      lastConnectedAt: harness.clock,
    })
    assert.equal(harness.transports[0]?.isOpen(), false)
    harness.manager.stop()
  })

  /*
   * A command names a computer and knows nothing about connections. Refusing an idle one would have
   * made every CLI call depend on a window being open somewhere on the machine.
   */
  it('dials for a command sent to an idle computer, and hangs up after it', async () => {
    const harness = new RemoteConnectionsManagerTest()
    harness.manager.start()

    const answer = await harness.manager.execute('target-endpoint', {
      protocol: 'appjamat-v3-control.v1',
      requestId: 'request-a',
      operation: 'sessions.list',
      body: {},
    })

    assert.equal(answer.ok, true)
    assert.deepEqual(harness.dials, ['target-endpoint'])
    await harness.settle()
    assert.equal(harness.manager.snapshot().outbound[0]?.status, 'idle')
    harness.manager.stop()
  })

  it('takes a full sessions snapshot after an event revision gap', async () => {
    const harness = new RemoteConnectionsManagerTest()
    harness.manager.start()
    await harness.manager.connectComputer('test', 'target-endpoint')
    await harness.waitUntil(() => harness.manager.snapshot().outbound[0]?.status === 'connected')
    const transport = harness.transports[0]
    if (!transport) throw new Error('Transport was not created')
    transport.snapshotRevision = 7
    transport.emitEvent(3)
    await harness.waitUntil(() => harness.manager.snapshot().outbound[0]?.sessions?.revision === 7)
    assert.equal(transport.sessionLists, 2)
    harness.manager.stop()
  })

  it('stops terminal mutations after an exit frame', async () => {
    const harness = new RemoteConnectionsManagerTest()
    harness.manager.start()
    await harness.manager.connectComputer('test', 'target-endpoint')
    await harness.waitUntil(() => harness.manager.snapshot().outbound[0]?.status === 'connected')
    await harness.manager.selectSession('target-endpoint', 'session-a')
    assert.partialDeepStrictEqual(await harness.manager.attachTerminal(
      'target-endpoint',
      'attach-a',
      { sessionId: 'session-a', size: null },
      () => undefined,
    ), { ok: true })
    harness.transports[0]?.emitTerminalFrame('attach-a', {
      type: 'terminal.exit',
      runtimeSessionId: 'runtime-a',
      generation: 1,
      exitCode: 0,
    })
    assert.partialDeepStrictEqual(await harness.manager.terminalInput('target-endpoint', 'attach-a', 'ignored'), { ok: false, error: { code: 'unavailable' } })
    harness.manager.stop()
  })

  /*
   * What a paired computer runs, and what it offers beyond the operations every controller may
   * call. One question after the connection stands, and the reason nothing else has to ask: the
   * tree draws no row for a computer that is not connected, so this is what the settings screen
   * reads instead.
   */
  it('reads the version and the offered operations from one hello, dropping a name it does not know', async () => {
    const harness = new RemoteConnectionsManagerTest()
    harness.manager.start()
    await harness.manager.connectComputer('test', 'target-endpoint')
    await harness.waitUntil(() =>
      harness.manager.snapshot().outbound[0]?.applicationVersion !== null)

    assert.partialDeepStrictEqual(harness.manager.snapshot().outbound[0], {
      status: 'connected',
      lastConnectedAt: harness.clock,
      nextRetryAt: null,
      applicationVersion: '2026.08.31.10.00',
      // `agents.forecast` was in the answer and is not in this build's list. A gate reads these, so
      // an operation nobody here can name must not arrive as one that is offered.
      optionalOperations: ['sessions.transcript'],
    })
    assert.deepEqual(harness.manager.snapshot().outbound[0]?.optionalOperations, ['sessions.transcript'])
    assert.equal(harness.transports[0]?.hellos, 1)
    harness.manager.stop()
  })

  /* An older computer grants no hello, which costs the two readings and not the connection. */
  it('stays connected to a computer that answers no hello', async () => {
    const harness = new RemoteConnectionsManagerTest(undefined, { offersHello: false })
    harness.manager.start()
    await harness.manager.connectComputer('test', 'target-endpoint')
    await harness.waitUntil(() => harness.manager.snapshot().outbound[0]?.status === 'connected')
    await new Promise<void>((resolve) => setTimeout(resolve, 50))

    assert.partialDeepStrictEqual(harness.manager.snapshot().outbound[0], {
      status: 'connected',
      applicationVersion: null,
      optionalOperations: null,
    })
    assert.equal(harness.transports[0]?.hellos, 0)
    harness.manager.stop()
  })

  /*
   * The wait between two dials, said as a moment rather than as a duration, and then dropped. The
   * screen that draws it is the only place a computer nothing answers at is drawn at all, and the
   * button beside it is for the person who has just started the far end or written the firewall
   * rule: the person decides when another attempt is wanted.
   */
  it('schedules no retry after failure and retries only when asked', async () => {
    const harness = new RemoteConnectionsManagerTest(undefined, { heldTimers: true })
    harness.refuseConnect = true
    harness.manager.start()
    await harness.manager.connectComputer('test', 'target-endpoint')
    await harness.waitUntil(() => harness.manager.snapshot().outbound[0]?.status === 'offline')

    assert.partialDeepStrictEqual(harness.manager.snapshot().outbound[0], {
      status: 'offline',
      lastConnectedAt: null,
      nextRetryAt: null,
    })
    assert.deepEqual(harness.timers, [])

    harness.manager.retryNow('endpoint-nobody-has')
    assert.deepEqual(harness.dials, ['target-endpoint'])

    harness.refuseConnect = false
    harness.clock += 5_000
    harness.manager.retryNow('target-endpoint')
    await harness.waitUntil(() => harness.manager.snapshot().outbound[0]?.status === 'connected')

    assert.deepEqual(harness.dials, ['target-endpoint', 'target-endpoint'])
    assert.partialDeepStrictEqual(harness.manager.snapshot().outbound[0], {
      lastConnectedAt: harness.clock,
      nextRetryAt: null,
    })
    harness.manager.stop()
  })

  it('keeps only selected sessions and disconnects without finalizing them', async () => {
    const harness = new RemoteConnectionsManagerTest()
    harness.manager.start()
    await harness.manager.connectComputer('dialog', 'target-endpoint')
    assert.deepEqual(harness.manager.snapshot().outbound[0]?.selectedSessionIds, [])
    assert.partialDeepStrictEqual(await harness.manager.selectSession('target-endpoint', 'missing'), { ok: false, error: { code: 'not-found' } })
    assert.partialDeepStrictEqual(await harness.manager.selectSession('target-endpoint', 'session-a'), { ok: true })
    await harness.manager.attachTerminal('target-endpoint', 'selected', { sessionId: 'session-a', size: null }, () => {})
    harness.manager.releaseConnections('dialog')
    await harness.settle()
    assert.equal(harness.manager.snapshot().outbound[0]?.status, 'connected')
    assert.deepEqual(harness.manager.snapshot().outbound[0]?.selectedSessionIds, ['session-a'])
    await harness.manager.disconnectSessions('target-endpoint', ['session-a'])
    await harness.settle()
    assert.deepEqual(harness.manager.snapshot().outbound[0]?.selectedSessionIds, [])
    assert.equal(harness.transports[0]?.isOpen(), false)
    assert.equal(harness.transports[0]?.detachRequests, 1)
    assert.deepEqual(harness.dials, ['target-endpoint'])
    harness.manager.stop()
  })

  it('admits the terminal of a script run through its selected parent, and its disconnect detaches it', async () => {
    const harness = new RemoteConnectionsManagerTest()
    harness.manager.start()
    await harness.manager.connectComputer('dialog', 'target-endpoint')
    assert.equal(harness.manager.admitsTerminal('target-endpoint', 'run-a'), false)
    assert.equal(harness.manager.admitsTerminal('target-endpoint', 'session-a'), false)
    await harness.manager.selectSession('target-endpoint', 'session-a')
    assert.equal(harness.manager.admitsTerminal('target-endpoint', 'session-a'), true)
    assert.equal(harness.manager.admitsTerminal('target-endpoint', 'run-a'), true)
    assert.equal(harness.manager.admitsTerminal('target-endpoint', 'run-unknown'), false)
    assert.equal(harness.manager.admitsTerminal('endpoint-gone', 'run-a'), false)
    assert.partialDeepStrictEqual(await harness.manager.attachTerminal('target-endpoint', 'run', { sessionId: 'run-a', size: null }, () => {}), { ok: true })
    await harness.manager.disconnectSessions('target-endpoint', ['session-a'])
    await harness.settle()
    assert.equal(harness.manager.admitsTerminal('target-endpoint', 'run-a'), false)
    assert.equal(harness.transports[0]?.detachRequests, 1)
    harness.manager.stop()
  })

  it('publishes new nested descendants, reattaches on explicit reconnect and preserves an independent child', async () => {
    const harness = new RemoteConnectionsManagerTest()
    harness.manager.start()
    await harness.manager.connectComputer('dialog', 'target-endpoint')
    await harness.manager.selectSession('target-endpoint', 'session-a')
    const transport = harness.transports[0]!
    const parent = harness.manager.snapshot().outbound[0]!.sessions!.sessions[0]!
    const child = { ...parent, sessionId: 'child', parent: { sessionId: 'session-a', kind: 'worker' as const, sameProject: false } }
    const grandchild = { ...parent, sessionId: 'grandchild', parent: { sessionId: 'child', kind: 'worktree' as const, sameProject: true } }
    const run = { ...parent, sessionId: 'nested-run', script: { parentId: 'grandchild', phase: 'before' as const, scriptId: 'setup' as const } }
    transport.additionalSessions = [child, grandchild, run, { ...parent, sessionId: 'sibling' }]
    transport.emitEvent(2)
    await harness.waitUntil(() => harness.manager.admitsTerminal('target-endpoint', 'nested-run'))
    assert.deepEqual(harness.manager.snapshot().outbound[0]?.reachableSessionIds, ['session-a', 'run-a', 'child', 'grandchild', 'nested-run'])
    assert.equal(harness.manager.admitsTerminal('target-endpoint', 'sibling'), false)
    await harness.manager.attachTerminal('target-endpoint', 'nested', { sessionId: 'nested-run', size: null }, () => {})
    assert.equal(transport.attachRequests, 1)
    await harness.manager.selectSession('target-endpoint', 'child')
    await harness.manager.disconnectSessions('target-endpoint', ['session-a'])
    assert.equal(transport.detachRequests, 0)
    assert.deepEqual(harness.manager.snapshot().outbound[0]?.reachableSessionIds, ['child', 'grandchild', 'nested-run'])

    transport.close()
    await harness.settle()
    assert.equal((harness.dials).length, 1)
    await harness.manager.connectComputer('dialog', 'target-endpoint')
    const reconnected = harness.transports[1]!
    assert.equal(reconnected.attachRequests, 0)
    reconnected.additionalSessions = transport.additionalSessions
    reconnected.emitEvent(3)
    await harness.waitUntil(() => reconnected.attachRequests === 1)
    reconnected.additionalSessions = []
    reconnected.emitEvent(4)
    await harness.waitUntil(() => !harness.manager.admitsTerminal('target-endpoint', 'nested-run'))
    await harness.manager.disconnectSessions('target-endpoint', ['child'])
    assert.equal(reconnected.detachRequests, 1)
    harness.manager.stop()
  })

  it('detaches a script run terminal with its parent after the peer collapsed the run', async () => {
    const harness = new RemoteConnectionsManagerTest()
    harness.manager.start()
    await harness.manager.connectComputer('dialog', 'target-endpoint')
    await harness.manager.selectSession('target-endpoint', 'session-a')
    const transport = harness.transports[0]
    if (!transport) throw new Error('Transport was not created')
    const frames: TerminalFrame[] = []
    await harness.manager.attachTerminal('target-endpoint', 'run', { sessionId: 'run-a', size: null }, (frame) => frames.push(frame))
    const listed = transport.sessionLists
    transport.runCollapsed = true
    transport.emitEvent(5)
    await harness.waitUntil(() => transport.sessionLists > listed)
    await harness.settle()
    assert.equal(harness.manager.admitsTerminal('target-endpoint', 'run-a'), false)

    await harness.manager.disconnectSessions('target-endpoint', ['session-a'])
    await harness.settle()

    assert.partialDeepStrictEqual(frames.at(-1), { type: 'terminal.status', status: 'lost' })
    assert.equal(transport.detachRequests, 1)
    harness.manager.stop()
  })

  /*
   * A tab restored at start attaches before anything is connected or selected. Refused without being
   * held, nothing attached it once the person connected and selected its session, and the tab stayed
   * an empty screen until the computer was disconnected and connected again.
   */
  it('holds a tab opened before its session is selected and attaches it once the session is selected', async () => {
    const harness = new RemoteConnectionsManagerTest()
    harness.manager.start()
    const frames: unknown[] = []
    assert.partialDeepStrictEqual(await harness.manager.attachTerminal(
      'target-endpoint', 'restored', { sessionId: 'session-a', size: null }, (frame) => frames.push(frame),
    ), { ok: false, error: { code: 'unavailable' } })
    assert.deepEqual(frames, [{
      type: 'terminal.status', status: 'connecting', detail: 'Select this session in Remote computers to connect it.',
    }])
    assert.deepEqual(harness.dials, [])

    await harness.manager.connectComputer('dialog', 'target-endpoint')
    const transport = harness.transports[0]
    if (!transport) throw new Error('Transport was not created')
    assert.equal(transport.attachRequests, 0)
    await harness.manager.selectSession('target-endpoint', 'session-a')
    await harness.waitUntil(() => transport.attachRequests === 1)
    assert.partialDeepStrictEqual(await harness.manager.terminalInput('target-endpoint', 'restored', 'typed'), { ok: true })
    harness.manager.stop()
  })

  it('uses versioned source pages and restarts discovery when a revision changes', async () => {
    const harness = new RemoteConnectionsManagerTest(undefined, { workspace: true })
    harness.manager.start()
    await harness.manager.connectComputer('dialog', 'target-endpoint')
    const transport = harness.transports[0]!
    assert.equal(transport.sessionLists, 0)
    assert.deepEqual(harness.manager.snapshot().outbound[0]?.workspaceCapabilities, ['session-workspace.read'])
    const parent = harness.manager.snapshot().outbound[0]!.sessions!.sessions[0]!
    transport.additionalSessions = [{ ...parent, sessionId: 'waiting', life: 'ended', workflow: {
      workflowId: 'update', kind: 'update-main', title: 'Update', badge: 'waits', summary: 'pending', open: true, rounds: [], actions: [],
    } }, { ...parent, sessionId: 'history', life: 'ended' }]
    transport.changePageRevision = true
    transport.emitEvent(3)
    await harness.waitUntil(() => harness.manager.snapshot().outbound[0]?.sessions?.sessions.some((row) => row.sessionId === 'waiting') === true)
    assert.equal(harness.manager.snapshot().outbound[0]?.sessions?.revision, 2)
    assert.equal(harness.manager.snapshot().outbound[0]?.sessions?.sessions.some((row) => row.sessionId === 'history'), false)
    harness.manager.stop()
  })

  it('assembles selected-session details across bounded pages and refuses foreign epochs or unselected sessions', async () => {
    const harness = new RemoteConnectionsManagerTest(undefined, { workspace: true })
    harness.manager.start()
    await harness.manager.connectComputer('dialog', 'target-endpoint')
    const transport = harness.transports[0]!
    const parent = harness.manager.snapshot().outbound[0]!.sessions!.sessions[0]!
    transport.additionalSessions = [{ ...parent, sessionId: 'large', note: 'x'.repeat(150_000) }]
    await harness.manager.selectSession('target-endpoint', 'large')
    const view = { viewId: 'view', viewerId: 'viewer', epoch: transport.connectionId, sessionId: 'large' }
    const answer = await harness.manager.sessionDetail('target-endpoint', view)
    assert.partialDeepStrictEqual(answer, { ok: true, value: { session: { sessionId: 'large', note: 'x'.repeat(150_000) } } })
    assert.partialDeepStrictEqual(await harness.manager.sessionDetail('target-endpoint', { ...view, epoch: 'foreign' }), { ok: false })
    assert.partialDeepStrictEqual(await harness.manager.sessionDetail('target-endpoint', { ...view, sessionId: 'session-a' }), { ok: false, error: { code: 'forbidden' } })
    harness.manager.stop()
  })

  it('closes only the selected remote session whose current source confirms its removal', async () => {
    const harness = new RemoteConnectionsManagerTest(undefined, { workspace: true })
    harness.manager.start()
    try {
      await harness.manager.connectComputer('dialog', 'target-endpoint')
      const transport = harness.transports[0]!
      const parent = harness.manager.snapshot().outbound[0]!.sessions!.sessions[0]!
      transport.additionalSessions = [{ ...parent, sessionId: 'finished' }]
      await harness.manager.selectSession('target-endpoint', 'finished')
      const view = { viewId: 'view', viewerId: 'viewer', epoch: transport.connectionId, sessionId: 'finished' }
      transport.additionalSessions = [{ ...parent, sessionId: 'finished', life: 'ended' }]
      transport.snapshotRevision++
      transport.emitEvent(transport.snapshotRevision)
      await harness.waitUntil(() => !harness.manager.snapshot().outbound[0]?.sessions?.sessions.some((row) => row.sessionId === 'finished'))
      assert.partialDeepStrictEqual(await harness.manager.sessionDetail('target-endpoint', view), { ok: true, value: { session: { life: 'ended' } } })
      assert.deepEqual(harness.removedSessions, [])

      transport.additionalSessions = []
      transport.snapshotRevision++
      assert.partialDeepStrictEqual(await harness.manager.sessionDetail('target-endpoint', { ...view, epoch: 'old-connection' }), { ok: false, error: { code: 'unavailable' } })
      assert.partialDeepStrictEqual(await harness.manager.sessionDetail('target-endpoint', { ...view, sessionId: 'unselected' }), { ok: false, error: { code: 'forbidden' } })
      assert.deepEqual(harness.removedSessions, [])
      assert.partialDeepStrictEqual(await harness.manager.sessionDetail('target-endpoint', view), { ok: false, error: { code: 'not-found' } })
      assert.deepEqual(harness.removedSessions, [{ remoteEndpointId: 'target-endpoint', sessionId: 'finished' }])

      transport.close()
      assert.partialDeepStrictEqual(await harness.manager.sessionDetail('target-endpoint', { ...view, sessionId: 'session-a' }), { ok: false, error: { code: 'unavailable' } })
      assert.equal((harness.removedSessions).length, 1)
    } finally { harness.manager.stop() }
  })

  it('waits for a reconciled peer snapshot before reattaching after a restart', async () => {
    const harness = new RemoteConnectionsManagerTest()
    harness.manager.start()
    await harness.manager.connectComputer('dialog', 'target-endpoint')
    await harness.manager.selectSession('target-endpoint', 'session-a')
    await harness.manager.attachTerminal('target-endpoint', 'restart', { sessionId: 'session-a', size: null }, () => {})
    harness.transports[0]?.close()
    harness.reconciled = false
    await harness.manager.connectComputer('dialog', 'target-endpoint')
    const transport = harness.transports[1]
    if (!transport) throw new Error('Transport was not created')
    assert.equal(transport.attachRequests, 0)
    assert.partialDeepStrictEqual(await harness.manager.attachTerminal('target-endpoint', 'new-tab', { sessionId: 'session-a', size: null }, () => {}), { ok: false, error: { code: 'unavailable' } })
    assert.equal(transport.attachRequests, 0)
    transport.reconciled = true
    transport.emitEvent(3)
    await harness.waitUntil(() => transport.attachRequests === 2)
    harness.manager.stop()
  })

  it('detaches a terminal that finishes opening after a local disconnect', async () => {
    const harness = new RemoteConnectionsManagerTest()
    harness.manager.start()
    await harness.manager.connectComputer('dialog', 'target-endpoint')
    await harness.manager.selectSession('target-endpoint', 'session-a')
    const transport = harness.transports[0]
    if (!transport) throw new Error('Transport was not created')
    let finish!: () => void
    transport.attachGate = new Promise<void>((resolve) => { finish = resolve })
    const attaching = harness.manager.attachTerminal(
      'target-endpoint', 'pending', { sessionId: 'session-a', size: null }, () => {},
    )
    await harness.manager.disconnectSessions('target-endpoint', ['session-a'])
    finish()
    assert.partialDeepStrictEqual(await attaching, { ok: false, error: { code: 'unavailable' } })
    assert.equal(transport.detachRequests, 1)
    assert.equal(transport.isOpen(), true)
    assert.deepEqual(harness.manager.snapshot().outbound[0]?.selectedSessionIds, [])
    harness.manager.stop()
  })

  it('cancels a pending dial when its dialog closes and ignores a late completion', async () => {
    const harness = new RemoteConnectionsManagerTest()
    let finish!: () => void
    harness.dialGate = new Promise<void>((resolve) => { finish = resolve })
    harness.manager.start()
    const connecting = harness.manager.connectComputer('dialog', 'target-endpoint')
    harness.manager.releaseConnections('dialog')
    await harness.settle()
    assert.equal(harness.signals[0]?.aborted, true)
    finish()
    assert.partialDeepStrictEqual(await connecting, { ok: false })
    assert.equal(harness.manager.snapshot().outbound[0]?.status, 'idle')
    assert.deepEqual(harness.transports, [])
    harness.manager.stop()
  })

  it('restoring a terminal never dials a saved computer', async () => {
    const harness = new RemoteConnectionsManagerTest()
    harness.manager.start()
    assert.partialDeepStrictEqual(await harness.manager.attachTerminal('target-endpoint', 'restored', { sessionId: 'session-a', size: null }, () => {}), { ok: false, error: { code: 'unavailable' } })
    await harness.settle()
    assert.deepEqual(harness.dials, [])
    assert.deepEqual(harness.timers, [])
    harness.manager.stop()
  })

  it('keeps public renderer snapshots free of pinned keys and allows duplicate display names', async () => {
    const harness = new RemoteConnectionsManagerTest([
      RemoteConnectionsManagerTest.profile('profile-a', 'computer-a', 'endpoint-a'),
      RemoteConnectionsManagerTest.profile('profile-b', 'computer-b', 'endpoint-b'),
    ])
    harness.manager.start()
    await harness.manager.connectComputer('a', 'endpoint-a')
    assert.deepEqual(harness.dials, ['endpoint-a'])
    assert.equal(harness.manager.snapshot().outbound[1]?.status, 'idle')
    await harness.manager.connectComputer('b', 'endpoint-b')
    await harness.waitUntil(() => harness.manager.snapshot().outbound.every((entry) =>
      entry.status === 'connected'))
    const snapshot = harness.manager.snapshot()
    assert.deepEqual(snapshot.outbound.map((entry) => entry.displayName), ['Same name', 'Same name'])
    const serialized = JSON.stringify(snapshot)
    assert.equal((serialized).includes('pinnedIdentity'), false)
    assert.equal((serialized).includes('publicKey'), false)
    assert.equal((serialized).includes('privateKey'), false)
    assert.equal((serialized).includes('token'), false)
    harness.manager.stop()
  })
})

interface RemoteConnectionsManagerTestTimer {
  milliseconds: number
  handle: ReturnType<typeof setTimeout>
  cleared: boolean
  fired: boolean
  callback: () => void
}

interface RemoteConnectionsManagerTestOptions {
  workspace?: boolean
  heldTimers?: boolean
  random?: number
  /** A peer that grants no hello - an older computer, which is a refusal and not a failure. */
  offersHello?: boolean
}

class RemoteConnectionsManagerTest {
  readonly transports: RemoteConnectionsManagerTestTransport[] = []
  readonly removedSessions: { remoteEndpointId: string; sessionId: string }[] = []
  readonly timers: RemoteConnectionsManagerTestTimer[] = []
  readonly dials: string[] = []
  readonly dialProfiles: RemoteControlPeerProfile[] = []
  readonly manager: RemoteConnectionsManager
  clock = 1_700_000_000_000
  refuseConnect = false
  refuseCode: 'unavailable' | 'forbidden' = 'unavailable'
  reconciled = true
  dialGate: Promise<void> | null = null
  readonly signals: AbortSignal[] = []
  private requestSequence = 0

  constructor(
    profiles: readonly RemoteControlPeerProfile[] = [
      RemoteConnectionsManagerTest.profile('target-profile', 'target-computer', 'target-endpoint'),
    ],
    options: RemoteConnectionsManagerTestOptions = {},
  ) {
    const held = options.heldTimers === true
    this.manager = new RemoteConnectionsManager({
      identity: RemoteConnectionsManagerTest.identity('local-computer', 'local-endpoint'),
      profiles: () => profiles,
      connect: async (profile, signal) => {
        this.dials.push(profile.remoteEndpointId)
        this.dialProfiles.push(structuredClone(profile))
        this.signals.push(signal)
        if (this.dialGate) await this.dialGate
        if (signal.aborted) return { ok: false, error: { code: 'unavailable', detail: 'Cancelled' } }
        if (this.refuseConnect)
          return { ok: false, error: { code: this.refuseCode, detail: 'Nothing answers there' } }
        const transport = new RemoteConnectionsManagerTestTransport(
          RemoteConnectionsManagerTest.identity(profile.remoteComputerId, profile.remoteEndpointId),
          `connection-${this.transports.length + 1}`,
          this.transports.length + 1,
          options.offersHello !== false,
          options.workspace === true,
        )
        transport.reconciled = this.reconciled
        this.transports.push(transport)
        return { ok: true, value: transport }
      },
      onChanged: () => {},
      onSessionRemoved: (remoteEndpointId: string, sessionId: string) => { this.removedSessions.push({ remoteEndpointId, sessionId }) },
      onError: (message) => { throw new Error(message) },
      requestId: () => `request-${++this.requestSequence}`,
      operationId: () => `operation-${this.requestSequence}`,
      idleDelayMilliseconds: 0,
      now: () => this.clock,
      ...(options.random === undefined ? {} : { random: () => options.random! }),
      ...(held
        ? {
            // A real handle so the manager's own `unref` and `clearTimeout` are the ones being
            // exercised; what it would run is this test's to call, and it never runs by itself.
            setTimer: (callback: () => void, milliseconds: number) => {
              const handle = setTimeout(() => undefined, 60_000)
              this.timers.push({ milliseconds, handle, cleared: false, fired: false, callback })
              return handle
            },
            clearTimer: (handle: ReturnType<typeof setTimeout>) => {
              clearTimeout(handle)
              const found = this.timers.find((timer) => timer.handle === handle)
              if (found) found.cleared = true
            },
          }
        : {}),
    })
  }

  /** Runs the one armed redial, as its delay running out would. */
  fireRetry(): void {
    const armed = this.timers.filter((timer) =>
      timer.milliseconds >= RemoteConnectionsManager.retryDelayMillisecondsConst && !timer.fired && !timer.cleared)
    if (armed.length !== 1) throw new Error(`Expected one armed redial, found ${armed.length}`)
    armed[0]!.fired = true
    clearTimeout(armed[0]!.handle)
    armed[0]!.callback()
  }

  /** One macrotask, which is what the zero-delay hang-up above waits for. */
  async settle(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }

  async waitUntil(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      if (condition()) return
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
    }
    throw new Error(`Remote manager test timed out: ${JSON.stringify(this.manager.snapshot())}`)
  }

  static profile(
    profileId: string,
    remoteComputerId: string,
    remoteEndpointId: string,
  ): RemoteControlPeerProfile {
    return {
      profileId,
      remoteComputerId,
      remoteEndpointId,
      configIdentity: `config-${remoteEndpointId}`,
      runtimeChannel: 'development',
      displayName: 'Same name',
      endpoint: { host: '127.0.0.1', port: 47_150 },
      pinnedIdentity: {
        algorithm: 'ed25519',
        publicKey: `${remoteEndpointId}a`.padEnd(64, 'a'),
        fingerprint: `${remoteEndpointId}b`.padEnd(43, 'b'),
      },
    }
  }

  static identity(remoteComputerId: string, remoteEndpointId: string): RemoteControlPeerIdentity {
    return {
      remoteComputerId,
      remoteEndpointId,
      configIdentity: `config-${remoteEndpointId}`,
      runtimeChannel: 'development',
      displayName: 'Same name',
      signing: {
        algorithm: 'ed25519',
        publicKey: `${remoteEndpointId}a`.padEnd(64, 'a'),
        fingerprint: `${remoteEndpointId}b`.padEnd(43, 'b'),
      },
    }
  }
}

class RemoteConnectionsManagerTestTransport implements RemoteControlPeerTransport {
  private readonly sessionSnapshots = new RemoteSessionSnapshots(() => this.listed())
  changePageRevision = false
  readonly capabilities: readonly RemoteControlPeerCapability[]
  private readonly messages = new Set<(message: RemoteControlPeerApplicationMessage) => void>()
  private readonly closes = new Set<() => void>()
  private open = true
  sessionLists = 0
  hellos = 0
  poisonSnapshot = false
  reconciled = true
  /** The peer has collapsed its script run: the run is gone from what it lists. */
  runCollapsed = false
  additionalSessions: SessionsSnapshot['sessions'][number][] = []
  refuseAttach = false
  attachGate: Promise<void> | null = null
  listGate: Promise<void> | null = null
  readonly sent: RemoteControlPeerApplicationMessage[] = []
  attachRequests = 0
  activeRequests = 0
  detachRequests = 0

  constructor(
    readonly remoteIdentity: RemoteControlPeerIdentity,
    readonly connectionId: string,
    public snapshotRevision: number,
    offersHello: boolean,
    workspace = false,
  ) {
    this.capabilities = [
      ...(workspace ? ['session-workspace.read' as const] : []),
      // A peer that grants no hello is a peer this side asks nothing of: the channel refuses the
      // call itself, which is how an older computer arrives rather than as a broken connection.
      ...(offersHello ? ['control:system.hello' as const] : []),
      'control:sessions.list',
      'socket:events.subscribe',
      'socket:terminal.attach',
      'socket:terminal.input',
      'socket:terminal.resize',
      'socket:terminal.active',
      'socket:terminal.detach',
    ]
  }

  isOpen(): boolean { return this.open }

  send(message: RemoteControlPeerApplicationMessage): boolean {
    if (!this.open) return false
    this.sent.push(message)
    if (message.type === 'socket-request' && message.request.operation === 'terminal.attach' && this.attachGate)
      void this.attachGate.then(() => this.answer(message))
    else if (message.type === 'control-request' && message.request.operation === 'sessions.list' && this.listGate)
      void this.listGate.then(() => this.answer(message))
    else queueMicrotask(() => this.answer(message))
    return true
  }

  onMessage(listener: (message: RemoteControlPeerApplicationMessage) => void): () => void {
    this.messages.add(listener)
    return () => this.messages.delete(listener)
  }

  captureListeners(): (message: RemoteControlPeerApplicationMessage) => void {
    const listeners = [...this.messages]
    return message => { for (const listener of listeners) listener(message) }
  }

  onClose(listener: () => void): () => void {
    this.closes.add(listener)
    return () => this.closes.delete(listener)
  }

  close(): void {
    if (!this.open) return
    this.open = false
    for (const listener of this.closes) listener()
  }

  emitEvent(revision: number): void {
    this.emit({
      type: 'socket-response',
      response: {
        protocol: 'appjamat-v3-control.v1',
        type: 'event',
        event: { revision, kind: 'sessions.changed', at: Date.now() },
      },
    })
  }

  emitTerminalFrame(attachId: string, frame: TerminalFrame): void {
    this.emit({
      type: 'socket-response',
      response: {
        protocol: 'appjamat-v3-control.v1',
        type: 'terminal.frame',
        attachId,
        frame,
        terminalOutputUntrusted: true,
      },
    })
  }

  private answer(message: RemoteControlPeerApplicationMessage): void {
    if (!this.open) return
    if (message.type === 'session-state-request') {
      if (this.changePageRevision && message.request.kind === 'sessions') {
        this.snapshotRevision++
        this.changePageRevision = false
      }
      this.emit({ type: 'session-state-response', response: { requestId: message.request.requestId,
        result: this.sessionSnapshots.page(message.request) } })
    } else if (message.type === 'control-request') {
      if (message.request.operation === 'system.hello') {
        this.hellos += 1
        this.emit({
          type: 'control-response',
          response: {
            protocol: 'appjamat-v3-control.v1',
            requestId: message.request.requestId,
            operation: message.request.operation,
            operationId: null,
            ok: true,
            value: RemoteConnectionsManagerTestTransport.hello(),
          },
        })
        return
      }
      if (message.request.operation !== 'sessions.list')
        throw new Error(`Unexpected control operation: ${message.request.operation}`)
      this.sessionLists += 1
      this.emit({
        type: 'control-response',
        response: {
          protocol: 'appjamat-v3-control.v1',
          requestId: message.request.requestId,
          operation: message.request.operation,
          operationId: null,
          ok: true,
          value: this.poisonSnapshot
            // The cast is the test: a peer on another computer is under no obligation to send
            // what this type says, and the local side has to survive that.
            ? {
                ...RemoteConnectionsManagerTestTransport.snapshot(this.snapshotRevision),
                sessions: [null],
              } as unknown as SessionsSnapshot
            : this.listed(),
        },
      })
    } else if (message.type === 'socket-request') {
      if (message.request.operation === 'terminal.attach') this.attachRequests += 1
      else if (message.request.operation === 'terminal.active') this.activeRequests += 1
      else if (message.request.operation === 'terminal.detach') this.detachRequests += 1
      if (this.refuseAttach && message.request.operation === 'terminal.attach') {
        this.emit({
          type: 'socket-response',
          response: {
            protocol: 'appjamat-v3-control.v1',
            type: 'response',
            requestId: message.request.requestId,
            operation: message.request.operation,
            operationId: message.request.operationId,
            ok: false,
            error: { code: 'not-found', detail: 'No such session over there' },
          },
        })
        return
      }
      this.emit({
        type: 'socket-response',
        response: {
          protocol: 'appjamat-v3-control.v1',
          type: 'response',
          requestId: message.request.requestId,
          operation: message.request.operation,
          operationId: message.request.operation === 'events.subscribe'
            ? null
            : message.request.operationId,
          ok: true,
          value: message.request.operation === 'events.subscribe'
            ? { throughRevision: 0, truncated: false }
            : message.request.operation === 'terminal.attach'
              ? { attachId: message.request.attachId, sessionId: message.request.sessionId }
              : { attachId: message.request.attachId },
        },
      })
    } else if (message.type === 'control-response' || message.type === 'socket-response')
      throw new Error(`Unexpected response from manager: ${message.type}`)
    else
      throw new Error(`Unknown manager message: ${JSON.stringify(message)}`)
  }

  private listed(): SessionsSnapshot {
    const snapshot = RemoteConnectionsManagerTestTransport.snapshot(this.snapshotRevision)
    return {
      ...snapshot,
      reconciled: this.reconciled,
      sessions: [
        ...(this.runCollapsed ? snapshot.sessions.filter((session) => session.script === undefined) : snapshot.sessions),
        ...this.additionalSessions,
      ],
    }
  }

  private emit(message: RemoteControlPeerApplicationMessage): void {
    for (const listener of this.messages) listener(message)
  }

  /**
   * What another computer says about itself. `agents.forecast` is deliberately NOT an operation
   * this build knows, and the cast is the test: a peer is under no obligation to send what this
   * type says, and a name this side has no gate for is dropped rather than kept or refused.
   */
  private static hello(): RemoteControlHelloDto {
    return {
      protocol: 'appjamat-v3-control.v1',
      configIdentity: 'config-target-endpoint',
      runtimeChannel: 'development',
      instanceId: 'instance-target',
      startedAt: 1_699_000_000_000,
      applicationVersion: '2026.08.31.10.00',
      operations: ['system.hello', 'sessions.list'],
      optionalOperations: ['sessions.transcript', 'agents.forecast'],
    } as unknown as RemoteControlHelloDto
  }

  private static snapshot(revision: number): SessionsSnapshot {
    return {
      revision,
      reconciled: true,
      host: {
        presence: 'running',
        hostVersion: 'test',
        hostInstanceId: 'host',
        liveCount: 0,
        lastStartError: null,
      },
      categories: [],
      sessions: [{
        sessionId: 'session-a',
        kind: 'agent',
        title: '014 remote work',
        titleParts: { number: '014', name: 'remote work' },
        tabTitle: 'Alpha - 014 remote work',
        directory: { mode: 'project', categoryId: 'code', projectPath: 'D:/code/Alpha' },
        project: {
          kind: 'project',
          categoryId: 'code',
          projectName: 'Alpha',
          projectPath: 'D:/code/Alpha',
        },
        agent: { agentId: 'codex', nativeSessionId: 'native-remote-1' },
        life: 'live',
        activity: 'idle',
        admits: [],
      }, {
        sessionId: 'run-a',
        kind: 'shell',
        title: 'Setup remote work',
        titleParts: { number: null, name: 'Setup remote work' },
        tabTitle: 'Alpha - Setup remote work',
        directory: { mode: 'project', categoryId: 'code', projectPath: 'D:/code/Alpha' },
        project: {
          kind: 'project',
          categoryId: 'code',
          projectName: 'Alpha',
          projectPath: 'D:/code/Alpha',
        },
        life: 'live',
        activity: 'idle',
        admits: [],
        script: { parentId: 'session-a', phase: 'before', scriptId: 'setup' },
      }],
      orphans: [],
    }
  }
}
