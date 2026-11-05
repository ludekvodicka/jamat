import { randomUUID } from 'node:crypto'
import type { ProcessCallContext } from '../../../lib-orchestrator/shared/processCalls'
import type { WindowTerminalPayload } from '../../../lib-orchestrator/shared/windowWire.types'
import type { TerminalPort } from '../../../lib-orchestrator/sessionManager/terminalPort'
import type { TerminalAttachSpec, TerminalFrame } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { WindowTerminalCall } from '../../../lib-orchestrator/sessionManager/windowTerminal.types'
import type { PerfSpans } from '../../../lib-orchestrator/perfMonitor/perfSpans'
import { ViewerBuffer } from './viewerBuffer'

interface Claim { id: string; spec: TerminalAttachSpec; active: boolean; lifetime: AbortController }

export class WindowTerminals {
  private readonly windowId: string
  private readonly terminals: Pick<TerminalPort, 'capabilities' | 'attach' | 'input' | 'resize' | 'setGeometryActive' | 'detach' | 'authorize'>
  private readonly claims: Map<string, Claim>
  private readonly output: ViewerBuffer<WindowTerminalPayload>
  private readonly report: (message: string) => void
  private readonly fatal: () => void
  private readonly perf: PerfSpans
  private paused: boolean
  private accepting: boolean
  private closed: boolean

  constructor(windowId: string, accepting: boolean, terminals: WindowTerminals['terminals'],
    output: ViewerBuffer<WindowTerminalPayload>, perf: PerfSpans, report: (message: string) => void, fatal: () => void) {
    this.windowId = windowId
    this.terminals = terminals
    this.report = report
    this.fatal = fatal
    this.perf = perf
    this.output = output
    this.claims = new Map()
    this.paused = false
    this.accepting = accepting
    this.closed = false
  }

  truncate(): void {
    this.paused = true
    for (const claim of this.claims.values()) { claim.lifetime.abort(); this.terminals.detach(claim.id) }
  }

  resume(): void {
    if (this.closed) return
    this.paused = false
    for (const [externalId, claim] of this.claims) {
      const replacement = { ...claim, id: randomUUID(), lifetime: new AbortController() }
      this.claims.set(externalId, replacement)
      void this.attach(externalId, replacement, true).catch(error => { this.report(String(error)); this.fatal() })
    }
  }

  async authorize(externalId: string): Promise<string | null> {
    const claim = this.claims.get(externalId)
    if (!claim || this.closed || this.paused) throw new Error(`Terminal attach is not owned by this renderer: ${externalId}`)
    const id = claim.id
    const answer = await this.terminals.authorize(this.windowId, id)
    return 'refused' in answer || this.claims.get(externalId) !== claim || claim.id !== id
      || this.closed || this.paused ? null : answer.sessionId
  }

  setAccepting(accepting: boolean): void { this.accepting = accepting }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const claim of this.claims.values())
      try { claim.lifetime.abort(); this.terminals.detach(claim.id) }
      catch (error) { this.report(String(error)) }
    this.claims.clear()
  }

  async invoke(call: WindowTerminalCall, context: ProcessCallContext): Promise<unknown> {
    if (this.closed || context.signal.aborted) throw new Error('Window terminal connection is closed')
    switch (call.method) {
      case 'terminal:attach': {
        const [externalId, spec] = call.args
        if (!this.accepting) throw new Error('The workspace window is closing')
        if (this.paused) throw new Error('Terminal output is reconnecting')
        if (this.claims.has(externalId)) throw new Error(`Attach id already claimed: ${externalId}`)
        const claim = { id: randomUUID(), spec, active: true, lifetime: new AbortController() }
        this.claims.set(externalId, claim)
        context.signal.addEventListener('abort', () => this.detach(externalId, claim), { once: true })
        try { return await this.attach(externalId, claim) }
        catch (error) { this.detach(externalId, claim); throw error }
      }
      case 'terminal:input': {
        const [externalId, data] = call.args
        const claim = this.claim(externalId)
        if (this.paused) throw new Error('Terminal output is reconnecting')
        context.signal.addEventListener('abort', () => this.detach(externalId, claim), { once: true })
        context.pending()
        await this.terminals.input(claim.id, data)
        return
      }
      case 'terminal:resize': {
        const [externalId, cols, rows] = call.args
        const claim = this.claim(externalId)
        claim.spec = { ...claim.spec, size: { cols, rows } }
        if (!this.paused) await this.terminals.resize(claim.id, cols, rows)
        return
      }
      case 'terminal:active': {
        const [externalId, active] = call.args
        const claim = this.claim(externalId)
        claim.active = active
        if (!this.paused) await this.terminals.setGeometryActive(claim.id, active)
        return
      }
      case 'terminal:detach': {
        const [externalId] = call.args
        const claim = this.claims.get(externalId)
        if (!claim) throw new Error(`Terminal attach is not owned by this window: ${externalId}`)
        this.detach(externalId, claim)
        return
      }
      default: throw new Error(`Unknown window terminal method: ${(call as { method: string }).method}`)
    }
  }

  private async attach(externalId: string, claim: Claim, recovering = false): Promise<Awaited<ReturnType<TerminalPort['attach']>>> {
    const id = claim.id
    const answer = await this.terminals.attach(id, claim.spec, { source: 'local', windowId: this.windowId,
      ...(this.terminals.capabilities?.snapshotStreaming ? { snapshotFlow: {
        reserve: async (frameBytesMax: number, signal: AbortSignal) => {
          const slot = await this.perf.span('gateway.frame', () => this.output.reserve(
            frameBytesMax + this.envelopeBytes(externalId), signal))
          return { release: () => slot.release(), send: frame => {
            if (this.claims.get(externalId) !== claim || claim.id !== id || this.closed || this.paused) {
              slot.release()
              return Promise.reject(new Error('Snapshot attach was replaced'))
            }
            return this.perf.span('gateway.frame', () => slot.send({ type: 'terminal-frame', attachId: externalId, frame }))
          } }
        },
      } } : {}),
      onFrame: frame => {
        if (this.claims.get(externalId) === claim && claim.id === id && !this.closed && !this.paused)
          try { this.perf.span('gateway.frame', () => {
            const value = { type: 'terminal-frame' as const, attachId: externalId, frame }
            if ((frame.type === 'terminal.snapshot' || frame.type === 'terminal.delta') && this.output.exceedsLimit(value)) {
              this.terminals.detach(claim.id)
              void this.output.reserve(1_024 + this.envelopeBytes(externalId), claim.lifetime.signal).then(async slot => {
                if (this.claims.get(externalId) !== claim || this.closed || this.paused) { slot.release(); return }
                await this.perf.span('gateway.frame', () => slot.send({ type: 'terminal-frame', attachId: externalId,
                  frame: { type: 'terminal.status', status: 'lost', detail: 'This Host cannot stream the terminal snapshot within the viewer limit. Upgrade the Host to restore this terminal view; its process is still running.' } }))
                this.detach(externalId, claim)
              }).catch(error => {
                if (claim.lifetime.signal.aborted || this.closed) return
                this.report(String(error)); this.fatal()
              })
              return
            }
            this.output.push(value)
          }) }
          catch (error) { this.report(String(error)); this.fatal() }
      },
    })
    if (this.claims.get(externalId) !== claim || claim.id !== id || this.closed || this.paused)
      this.terminals.detach(id)
    else if (!answer.ok) {
      if (recovering) {
        const frame: Extract<TerminalFrame, { type: 'terminal.status' }> = { type: 'terminal.status', status: 'lost', detail: answer.detail }
        switch (answer.code) {
          case 'not-live': case 'unknown-session': frame.code = answer.code; break
          case 'host-unreachable': break
          default: throw new Error(`Unknown terminal attach refusal: ${answer.code}`)
        }
        if (!this.output.push({ type: 'terminal-frame', attachId: externalId, frame })) this.fatal()
      }
      this.detach(externalId, claim)
    }
    else if (answer.ok) { if (!claim.active) await this.terminals.setGeometryActive(id, false) }
    else throw new Error(`Unknown terminal attach result: ${JSON.stringify(answer)}`)
    return answer
  }

  private envelopeBytes(attachId: string): number {
    return Buffer.byteLength(JSON.stringify({ type: 'terminal-frame', attachId, frame: null,
      generation: Number.MAX_SAFE_INTEGER, sequence: Number.MAX_SAFE_INTEGER })) - 4
  }

  private claim(externalId: string): Claim {
    const claim = this.claims.get(externalId)
    if (!claim || this.closed) throw new Error(`Terminal attach is not owned by this window: ${externalId}`)
    return claim
  }

  private detach(externalId: string, claim: Claim): void {
    if (this.claims.get(externalId) !== claim) return
    this.claims.delete(externalId)
    claim.lifetime.abort()
    this.terminals.detach(claim.id)
  }
}
