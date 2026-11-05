import { randomUUID } from 'node:crypto'
import type { ProcessCallContext } from '../../../lib-orchestrator/shared/processCalls'
import type { WindowTerminalPayload } from '../../../lib-orchestrator/shared/windowWire.types'
import type { WindowRemoteCall } from '../../../lib-orchestrator/remoteControl/windowRemote.types'
import type { RemoteOutboundPort, RemotePasteFileChunk } from '../../../lib-orchestrator/remoteControl/remoteOutbound.types'
import type { RemoteConnectionsSnapshot } from '../../../lib-orchestrator/remoteControl/remoteConnectionsApi.types'
import type { RemoteConnectionsHoldReason } from '../../../lib-orchestrator/remoteControl/remoteConnectionsHold'
import type { RemoteControlRequestUnion, RemoteControlStepResult } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import { RemoteControlConst } from '../../../lib-orchestrator/remoteControl/remoteControlProtocol'
import { RemoteSessionCommandsContract } from '../../../lib-orchestrator/remoteControl/remoteSessionCommand'
import type { RemoteSessionView, RemoteSessionViewRequest } from '../../../lib-orchestrator/remoteControl/remoteSessionApi.types'
import type { TerminalAttachSpec } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { TerminalClipboardPaste } from '../../../lib-orchestrator/sessionManager/terminalClipboardPaste'
import type { PerfSpans } from '../../../lib-orchestrator/perfMonitor/perfSpans'
import type { ViewerBuffer } from '../terminals/viewerBuffer'

export interface WindowPeersDependencies {
  outbound(): RemoteOutboundPort
  snapshot(): RemoteConnectionsSnapshot
  clipboard(endpointId: string, privateId: string, signal: AbortSignal): Promise<RemoteControlStepResult<TerminalClipboardPaste>>
  releaseMedia(endpointId: string, viewId: string, documentId?: string): void
}

interface Claim {
  id: string
  endpointId: string
  externalId: string
  spec: TerminalAttachSpec
  active: boolean | null
  lifetime: AbortController
}

const contentOperations = {
  'remote:changes-request': 'changes.request', 'remote:changes-page': 'changes.page',
  'remote:reviews-request': 'reviews.request', 'remote:reviews-page': 'reviews.page',
  'remote:sidebar-request': 'sidebar.request', 'remote:sidebar-page': 'sidebar.page',
  'remote:tasks-request': 'tasks.request', 'remote:tasks-page': 'tasks.page',
  'remote:items-open': 'items.open', 'remote:items-request': 'items.request', 'remote:items-page': 'items.page',
  'remote:files-request': 'files.request', 'remote:files-page': 'files.page',
} as const

export class WindowPeers {
  private readonly ownerId: string
  private readonly deps: WindowPeersDependencies
  private readonly output: ViewerBuffer<WindowTerminalPayload>
  private readonly perf: Pick<PerfSpans, 'span'>
  private readonly report: (message: string) => void
  private readonly fatal: () => void
  private readonly claims = new Map<string, Claim>()
  private readonly views = new Map<string, { endpointId: string; view: RemoteSessionView }>()
  private readonly holds = new Map<RemoteConnectionsHoldReason, string>()
  private accepting: boolean
  private paused = false
  private closed = false

  constructor(ownerId: string, accepting: boolean, deps: WindowPeersDependencies, output: ViewerBuffer<WindowTerminalPayload>,
    perf: Pick<PerfSpans, 'span'>, report: (message: string) => void, fatal: () => void) {
    this.ownerId = ownerId
    this.accepting = accepting
    this.deps = deps
    this.output = output
    this.perf = perf
    this.report = report
    this.fatal = fatal
  }

  async invoke(call: WindowRemoteCall, context: ProcessCallContext): Promise<unknown> {
    if (this.closed || context.signal.aborted) throw new Error('Remote window connection is closed')
    const outbound = this.deps.outbound()
    switch (call.method) {
      case 'remote:changes-request': case 'remote:changes-page': case 'remote:reviews-request': case 'remote:reviews-page':
      case 'remote:sidebar-request': case 'remote:sidebar-page': case 'remote:tasks-request': case 'remote:tasks-page':
      case 'remote:items-open': case 'remote:items-request': case 'remote:items-page': case 'remote:files-request': case 'remote:files-page': {
        const [endpointId, viewId, body] = call.args
        const held = this.authorizeView(endpointId, viewId)
        if (call.method === 'remote:files-request' && call.args[2].kind === 'release')
          this.deps.releaseMedia(endpointId, viewId, call.args[2].documentId)
        const answer = await outbound.sessionView(endpointId, { ...held, requestId: randomUUID(), operation: contentOperations[call.method], body } as RemoteSessionViewRequest)
        if (!answer.ok) return answer
        if (!answer.value || !('transferId' in answer.value)) throw new Error('Invalid remote content response')
        return { ok: true, value: answer.value }
      }
      case 'remote:view-open': {
        this.admit()
        const [endpointId, sessionId] = call.args
        const epoch = outbound.viewEpoch(endpointId)
        if (!epoch) return WindowPeers.unavailable('Remote session is offline')
        const answer = await outbound.sessionView(endpointId, {
          requestId: randomUUID(), epoch, operation: 'views.open', body: { sessionId, viewerId: randomUUID() },
        })
        if (!answer.ok) return answer
        if (!answer.value || !('viewId' in answer.value)) throw new Error('The peer returned no session view')
        const view = answer.value
        if (this.closed || !this.accepting || context.signal.aborted || outbound.viewEpoch(endpointId) !== epoch) {
          this.releaseView(endpointId, view)
          return WindowPeers.unavailable('The workspace window or remote session closed')
        }
        this.views.set(WindowPeers.key(endpointId, view.viewId), { endpointId, view })
        context.signal.addEventListener('abort', () => {
          if (this.views.get(WindowPeers.key(endpointId, view.viewId))?.view !== view) return
          this.views.delete(WindowPeers.key(endpointId, view.viewId))
          this.releaseView(endpointId, view)
        }, { once: true })
        return { ok: true, value: view }
      }
      case 'remote:view-detail': {
        const [endpointId, viewId] = call.args
        return outbound.sessionDetail(endpointId, this.authorizeView(endpointId, viewId))
      }
      case 'remote:view-close': {
        const [endpointId, viewId] = call.args
        const view = this.authorizeView(endpointId, viewId)
        this.views.delete(WindowPeers.key(endpointId, viewId))
        this.deps.releaseMedia(endpointId, viewId)
        const answer = await outbound.sessionView(endpointId, { ...view, requestId: randomUUID(), operation: 'views.close', body: {} })
        return answer.ok ? { ok: true, value: null } : answer
      }
      case 'remote:view-press': {
        this.admit()
        const [endpointId, viewId, body, operationId] = call.args
        const answer = await outbound.sessionView(endpointId, { ...this.authorizeView(endpointId, viewId), requestId: randomUUID(), operationId, operation: 'actions.press', body })
        return answer.ok ? { ok: true, value: null } : answer
      }
      case 'remote:snapshot': return this.deps.snapshot()
      case 'remote:connect': {
        this.admit()
        const [reason, endpointId] = call.args
        const hold = randomUUID()
        this.holds.set(reason, hold)
        context.signal.addEventListener('abort', () => {
          if (this.holds.get(reason) === hold) this.releaseHold(reason)
        }, { once: true })
        return outbound.connectComputer(this.holdKey(reason), endpointId)
      }
      case 'remote:release': this.releaseHold(call.args[0]); return
      case 'remote:select-session': return outbound.selectSession(...call.args)
      case 'remote:disconnect': return outbound.disconnectSessions(...call.args)
      case 'remote:agents-describe': return outbound.execute(call.args[0], this.request({ operation: 'agents.describe', body: {} }))
      case 'remote:accounts-list': return outbound.execute(call.args[0], this.request({ operation: 'accounts.list', body: {} }))
      case 'remote:projects-list': return outbound.execute(call.args[0], this.request({ operation: 'projects.list', body: structuredClone(call.args[1]) }))
      case 'remote:session-command': {
        this.admit()
        const [endpointId, command] = call.args
        if (!RemoteSessionCommandsContract.operations.some(operation => operation === command.operation)) throw new Error('This session command is not admitted')
        return outbound.execute(endpointId, { ...command, protocol: RemoteControlConst.protocol, requestId: randomUUID() })
      }
      case 'remote:sessions-create': {
        this.admit()
        const [endpointId, spec, operationId] = call.args
        const request = this.request({ operation: 'sessions.create', operationId, body: { spec: structuredClone(spec) } })
        if (spec.worktree !== undefined) {
          const capabilities = outbound.snapshot().outbound.find(entry => entry.remoteEndpointId === endpointId)?.workspaceCapabilities
          if (!capabilities?.includes('session-workspace.views') || !capabilities.includes('session-workspace.actions'))
            return { protocol: request.protocol, requestId: request.requestId, operation: request.operation, operationId,
              ok: false, error: { code: 'unavailable', detail: 'This peer cannot display worktree setup approval. Update it before creating a worktree here.' } }
        }
        return outbound.execute(endpointId, request)
      }
      case 'remote:sessions-reopen': return outbound.execute(call.args[0], this.request({ operation: 'sessions.reopen', operationId: randomUUID(), body: { session: { kind: 'sessionId', sessionId: call.args[1] } } }))
      case 'remote:sessions-finalize': return outbound.execute(call.args[0], this.request({ operation: 'sessions.finalize', operationId: randomUUID(), body: {
        session: { kind: 'sessionId', sessionId: call.args[1] }, ...(call.args[2] === undefined ? {} : { acknowledgeSetup: call.args[2] }),
      } }))
      case 'remote:sessions-reference': return outbound.sessionReference(...call.args)
      case 'remote:terminal-attach': {
        this.admit()
        if (this.paused) throw new Error('Terminal output is reconnecting')
        const [endpointId, externalId, spec] = call.args
        const key = WindowPeers.key(endpointId, externalId)
        if (this.claims.has(key)) throw new Error(`Remote terminal attach already exists: ${externalId}`)
        const claim: Claim = { id: randomUUID(), endpointId, externalId, spec: structuredClone(spec), active: null, lifetime: new AbortController() }
        this.claims.set(key, claim)
        context.signal.addEventListener('abort', () => { void this.detach(claim) }, { once: true })
        try { return await this.attach(claim) }
        catch (error) { await this.detach(claim); throw error }
      }
      case 'remote:terminal-input': {
        const claim = this.claim(call.args[0], call.args[1])
        if (this.paused) throw new Error('Terminal output is reconnecting')
        context.signal.addEventListener('abort', () => { void this.detach(claim).catch(error => this.report(String(error))) }, { once: true })
        context.pending()
        return outbound.terminalInput(claim.endpointId, claim.id, call.args[2])
      }
      case 'remote:terminal-resize': {
        const [endpointId, externalId, cols, rows] = call.args
        const claim = this.claim(endpointId, externalId)
        claim.spec = { ...claim.spec, size: { cols, rows } }
        return this.paused ? WindowPeers.unavailable('Terminal output is reconnecting') : outbound.terminalResize(endpointId, claim.id, cols, rows)
      }
      case 'remote:terminal-active': {
        const claim = this.claim(call.args[0], call.args[1])
        claim.active = call.args[2]
        return this.paused ? WindowPeers.unavailable('Terminal output is reconnecting') : outbound.terminalActive(claim.endpointId, claim.id, claim.active)
      }
      case 'remote:terminal-detach': return this.detach(this.claim(...call.args))
      case 'remote:terminal-clipboard-paste': {
        this.admit()
        const claim = this.claim(...call.args)
        if (this.paused) throw new Error('Terminal output is reconnecting')
        context.pending()
        const answer = await this.deps.clipboard(claim.endpointId, claim.id, AbortSignal.any([context.signal, claim.lifetime.signal]))
        if (!this.current(claim)) throw new Error('Remote terminal attach was replaced')
        return answer
      }
      default: throw new Error(`Unknown remote window operation: ${(call as { method: string }).method}`)
    }
  }

  authorizeView(endpointId: string, viewId: string): RemoteSessionView {
    const held = this.views.get(WindowPeers.key(endpointId, viewId))
    if (this.closed || !held || this.deps.outbound().viewEpoch(endpointId) !== held.view.epoch)
      throw new Error('Session view is not owned by this renderer')
    return structuredClone(held.view)
  }

  pasteImage(endpointId: string, privateId: string, data: string): ReturnType<RemoteOutboundPort['terminalPasteImage']> {
    this.privateClaim(endpointId, privateId)
    return this.deps.outbound().terminalPasteImage(endpointId, privateId, data)
  }

  pasteFile(endpointId: string, privateId: string, chunk: RemotePasteFileChunk): ReturnType<RemoteOutboundPort['terminalPasteFile']> {
    this.privateClaim(endpointId, privateId)
    return this.deps.outbound().terminalPasteFile(endpointId, privateId, chunk)
  }

  setAccepting(value: boolean): void { this.accepting = value }

  truncate(): void {
    this.paused = true
    for (const claim of this.claims.values()) {
      claim.lifetime.abort()
      void this.deps.outbound().detachTerminal(claim.endpointId, claim.id).catch(error => this.report(String(error)))
    }
  }

  resume(): void {
    if (this.closed) return
    this.paused = false
    for (const [key, old] of this.claims) {
      const claim = { ...old, id: randomUUID(), lifetime: new AbortController() }
      this.claims.set(key, claim)
      void this.attach(claim, true).catch(error => { this.report(String(error)); this.fatal() })
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const reason of this.holds.keys()) this.releaseHold(reason)
    for (const { endpointId, view } of this.views.values()) this.releaseView(endpointId, view)
    this.views.clear()
    for (const claim of this.claims.values()) void this.detach(claim).catch(error => this.report(String(error)))
  }

  private async attach(claim: Claim, recovering = false): ReturnType<RemoteOutboundPort['attachTerminal']> {
    const outbound = this.deps.outbound()
    const answer = await outbound.attachTerminal(claim.endpointId, claim.id, claim.spec, frame => {
      if (!this.current(claim) || this.paused) return
      try { this.perf.span('gateway.frame', () => this.output.push({ type: 'remote-terminal-frame', endpointId: claim.endpointId, attachId: claim.externalId, frame })) }
      catch (error) { this.report(String(error)); this.fatal() }
      if (frame.type === 'terminal.status' && frame.status === 'lost')
        void this.detach(claim).catch(error => this.report(String(error)))
    }, claim.active ?? undefined)
    if (!this.current(claim) || this.paused) {
      await outbound.detachTerminal(claim.endpointId, claim.id)
      return WindowPeers.unavailable('Remote terminal attach was replaced')
    }
    if (!answer.ok) {
      if (answer.error.code !== 'unavailable') {
        if (recovering && !this.output.push({ type: 'remote-terminal-frame', endpointId: claim.endpointId, attachId: claim.externalId,
          frame: { type: 'terminal.status', status: 'lost', detail: answer.error.detail } })) this.fatal()
        await this.detach(claim)
      }
      return answer
    }
    if (claim.active !== null) await outbound.terminalActive(claim.endpointId, claim.id, claim.active)
    return { ok: true, value: { ...answer.value, attachId: claim.externalId } }
  }

  private async detach(claim: Claim): ReturnType<RemoteOutboundPort['detachTerminal']> {
    const key = WindowPeers.key(claim.endpointId, claim.externalId)
    if (this.claims.get(key) !== claim) return WindowPeers.unavailable('Remote terminal attach was replaced')
    this.claims.delete(key)
    claim.lifetime.abort()
    return this.deps.outbound().detachTerminal(claim.endpointId, claim.id)
  }

  private current(claim: Claim): boolean { return !this.closed && this.claims.get(WindowPeers.key(claim.endpointId, claim.externalId)) === claim }
  private claim(endpointId: string, externalId: string): Claim {
    const claim = this.claims.get(WindowPeers.key(endpointId, externalId))
    if (!claim || this.closed) throw new Error(`Remote terminal attach is not owned by this renderer: ${externalId}`)
    return claim
  }
  private privateClaim(endpointId: string, privateId: string): Claim {
    this.admit()
    for (const claim of this.claims.values())
      if (!this.paused && claim.endpointId === endpointId && claim.id === privateId && !claim.lifetime.signal.aborted) return claim
    throw new Error('Remote terminal clipboard authorization expired')
  }
  private releaseView(endpointId: string, view: RemoteSessionView): void {
    this.deps.releaseMedia(endpointId, view.viewId)
    void this.deps.outbound().sessionView(endpointId, { ...view, requestId: randomUUID(), operation: 'views.close', body: {} }).catch(error => this.report(String(error)))
  }
  private releaseHold(reason: RemoteConnectionsHoldReason): void {
    if (!this.holds.delete(reason)) return
    this.deps.outbound().releaseConnections(this.holdKey(reason))
  }
  private holdKey(reason: RemoteConnectionsHoldReason): string { return `${this.ownerId} ${reason}` }
  private admit(): void { if (this.closed || !this.accepting) throw new Error('The workspace window is closing') }
  private request(value: RequestInput): RemoteControlRequestUnion {
    return { ...value, protocol: RemoteControlConst.protocol, requestId: randomUUID() } as RemoteControlRequestUnion
  }
  private static key(endpointId: string, id: string): string { return JSON.stringify([endpointId, id]) }
  private static unavailable(detail: string): RemoteControlStepResult<never> { return { ok: false, error: { code: 'unavailable', detail } } }
}

type RequestInput = RemoteControlRequestUnion extends infer T ? T extends RemoteControlRequestUnion ? Omit<T, 'protocol' | 'requestId'> : never : never
