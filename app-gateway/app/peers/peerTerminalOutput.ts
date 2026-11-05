import { randomUUID } from 'node:crypto'
import type { RemoteControlLiveTerminal } from '../../../lib-orchestrator/remoteControl/remoteControlLiveTerminal'
import type { RemoteControlSocketResponse, RemoteControlStepResult } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type { RemoteControlPeerTransport } from '../../../lib-orchestrator/remoteControl/remoteConnectionsApi.types'
import { RemoteControlConst } from '../../../lib-orchestrator/remoteControl/remoteControlProtocol'
import { RemoteControlPeerConst } from '../../../lib-orchestrator/remoteControl/remoteControlPeerProtocol'
import type { TerminalAttachSpec, TerminalFrame } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { PastedFileChunk } from '../../../lib-orchestrator/pastedFiles/pastedFileStore'
import type { PerfSpans } from '../../../lib-orchestrator/perfMonitor/perfSpans'
import { ViewerBuffer } from '../terminals/viewerBuffer'

type TerminalMessage = { type: 'socket-response'; response: Extract<RemoteControlSocketResponse, { type: 'terminal.frame' }> }
type BufferedFrame = { message: TerminalMessage; bytes: number }
type LivePort = Pick<RemoteControlLiveTerminal, 'attachLive' | 'inputLive' | 'resizeLive' | 'setLiveActive' | 'detachLive' | 'detachOwner' | 'pasteImageLive' | 'pasteFileLive'>
interface Claim {
  privateId: string
  spec: TerminalAttachSpec
  active: boolean
  frame(frame: TerminalFrame): void
}

export class PeerTerminalOutput {
  private readonly ownerId: string
  private readonly terminal: LivePort
  private readonly peer: Pick<RemoteControlPeerTransport, 'send' | 'close'>
  private readonly perf: Pick<PerfSpans, 'span'>
  private readonly claims: Map<string, Claim>
  private readonly output: ViewerBuffer<BufferedFrame>
  private reset: number | null
  private paused: boolean
  private closed: boolean

  constructor(ownerId: string, terminal: LivePort, peer: PeerTerminalOutput['peer'], perf: Pick<PerfSpans, 'span'>) {
    this.ownerId = ownerId
    this.terminal = terminal
    this.peer = peer
    this.perf = perf
    this.claims = new Map()
    this.reset = null
    this.paused = false
    this.closed = false
    this.output = new ViewerBuffer<BufferedFrame>({
      bytesOf: value => value.bytes,
      send: ({ message }, generation, sequence) => {
        const sent = this.peer.send(message, error => {
          if (this.closed) return
          if (error) { this.failPeer(); return }
          this.output.received(generation, sequence)
          if (this.reset !== null) this.output.resetReceived(this.reset)
        })
        if (!sent) this.failPeer()
      },
      truncate: generation => {
        this.reset = generation
        this.paused = true
        for (const claim of this.claims.values()) this.terminal.detachLive(this.ownerId, claim.privateId)
      },
      resume: () => {
        this.reset = null
        this.paused = false
        for (const [attachId, old] of this.claims) {
          // Claims change with the peer stream generation; late attach results retain their old id.
          const next: Claim = { ...old, privateId: randomUUID() }
          this.claims.set(attachId, next)
          void this.attach(attachId, next, true).catch(() => {})
        }
      },
    })
  }

  async attachLive(ownerId: string, attachId: string, spec: TerminalAttachSpec, onFrame: (frame: TerminalFrame) => void): ReturnType<LivePort['attachLive']> {
    if (ownerId !== this.ownerId || this.closed) return PeerTerminalOutput.missing(attachId)
    if (this.paused) return { ok: false, error: { code: 'unavailable', detail: 'Terminal output is reconnecting' } }
    if (this.claims.has(attachId)) return { ok: false, error: { code: 'conflict', detail: `Terminal attach ${JSON.stringify(attachId)} already exists` } }
    const claim: Claim = { privateId: randomUUID(), spec: structuredClone(spec), active: true, frame: onFrame }
    this.claims.set(attachId, claim)
    return this.attach(attachId, claim)
  }

  async inputLive(ownerId: string, attachId: string, data: string): ReturnType<LivePort['inputLive']> {
    const claim = this.owned(ownerId, attachId)
    if (!claim || this.paused) return PeerTerminalOutput.missing(attachId)
    const result = await this.terminal.inputLive(this.ownerId, claim.privateId, data)
    return result.ok ? { ok: true, value: { ...result.value, attachId } } : result
  }

  async resizeLive(ownerId: string, attachId: string, cols: number, rows: number): ReturnType<LivePort['resizeLive']> {
    const claim = this.owned(ownerId, attachId)
    if (!claim) return PeerTerminalOutput.missing(attachId)
    claim.spec = { ...claim.spec, size: { cols, rows } }
    if (this.paused) return { ok: true, value: { attachId, accepted: true, applied: false } }
    const result = await this.terminal.resizeLive(this.ownerId, claim.privateId, cols, rows)
    return result.ok ? { ok: true, value: { ...result.value, attachId } } : result
  }

  async setLiveActive(ownerId: string, attachId: string, active: boolean): ReturnType<LivePort['setLiveActive']> {
    const claim = this.owned(ownerId, attachId)
    if (!claim) return PeerTerminalOutput.missing(attachId)
    claim.active = active
    if (this.paused) return { ok: true, value: { attachId, accepted: true, applied: false } }
    const result = await this.terminal.setLiveActive(this.ownerId, claim.privateId, active)
    return result.ok ? { ok: true, value: { ...result.value, attachId } } : result
  }

  async pasteImageLive(ownerId: string, attachId: string, bytes: Uint8Array): ReturnType<LivePort['pasteImageLive']> {
    const claim = this.owned(ownerId, attachId)
    if (!claim || this.paused) return PeerTerminalOutput.missing(attachId)
    const result = await this.terminal.pasteImageLive(this.ownerId, claim.privateId, bytes)
    if (this.claims.get(attachId) !== claim) return PeerTerminalOutput.missing(attachId)
    return result.ok ? { ok: true, value: { ...result.value, attachId } } : result
  }

  async pasteFileLive(ownerId: string, attachId: string, uploadId: string, chunk: PastedFileChunk): ReturnType<LivePort['pasteFileLive']> {
    const claim = this.owned(ownerId, attachId)
    if (!claim || this.paused) return PeerTerminalOutput.missing(attachId)
    const result = await this.terminal.pasteFileLive(this.ownerId, claim.privateId, uploadId, chunk)
    if (this.claims.get(attachId) !== claim) return PeerTerminalOutput.missing(attachId)
    return result.ok ? { ok: true, value: { ...result.value, attachId } } : result
  }

  detachLive(ownerId: string, attachId: string): ReturnType<LivePort['detachLive']> {
    const claim = this.owned(ownerId, attachId)
    if (!claim) return PeerTerminalOutput.missing(attachId)
    this.claims.delete(attachId)
    this.terminal.detachLive(this.ownerId, claim.privateId)
    return { ok: true, value: { attachId } }
  }

  detachOwner(ownerId: string): void {
    if (ownerId !== this.ownerId || this.closed) return
    this.closed = true
    this.output.close()
    this.claims.clear()
    this.terminal.detachOwner(this.ownerId)
  }

  private async attach(attachId: string, claim: Claim, recovering = false): ReturnType<LivePort['attachLive']> {
    try {
      const result = await this.terminal.attachLive(this.ownerId, claim.privateId, claim.spec, frame => {
        if (this.claims.get(attachId) !== claim || this.paused || this.closed) return
        this.perf.span('gateway.frame', () => {
          const message: TerminalMessage = { type: 'socket-response', response: { protocol: RemoteControlConst.protocol,
            type: 'terminal.frame', attachId, frame, terminalOutputUntrusted: true } }
          // The existing LAN plaintext limit is smaller than one viewer's queue. An oversized
          // atomic frame still closes the peer; it must not enter a truncate/reattach loop.
          const bytes = Buffer.byteLength(JSON.stringify(message))
          if (bytes > RemoteControlPeerConst.maximumPlaintextBytes) { this.failPeer(); return }
          const ending = frame.type === 'terminal.exit' || frame.type === 'terminal.status' && frame.status === 'lost'
          if (!this.output.push({ message, bytes }) && ending) { this.failPeer(); return }
          if (this.closed) return
          claim.frame(frame)
          if (ending) {
            if (this.claims.get(attachId) === claim) this.claims.delete(attachId)
          }
        })
      })
      if (this.claims.get(attachId) !== claim) {
        if (result.ok) this.terminal.detachLive(this.ownerId, claim.privateId)
        return PeerTerminalOutput.lost()
      }
      if (!result.ok) {
        this.claims.delete(attachId)
        if (recovering) this.failPeer()
        return result
      }
      if (!claim.active && !this.paused) await this.terminal.setLiveActive(this.ownerId, claim.privateId, false)
      return { ok: true, value: { attachId, sessionId: claim.spec.sessionId } }
    } catch (error) {
      const current = this.claims.get(attachId)
      if (current === claim) this.claims.delete(attachId)
      this.terminal.detachLive(this.ownerId, claim.privateId)
      if (current !== claim) return PeerTerminalOutput.lost()
      if (recovering) this.failPeer()
      throw error
    }
  }

  private owned(ownerId: string, attachId: string): Claim | undefined {
    return ownerId === this.ownerId && !this.closed ? this.claims.get(attachId) : undefined
  }

  private failPeer(): void {
    if (this.closed) return
    try { this.detachOwner(this.ownerId) }
    finally { this.peer.close() }
  }

  private static lost(): RemoteControlStepResult<never> {
    return { ok: false, error: { code: 'unavailable', detail: 'The terminal attach disappeared' } }
  }

  private static missing(attachId: string): RemoteControlStepResult<never> {
    return { ok: false, error: { code: 'not-found', detail: `No terminal attach ${JSON.stringify(attachId)}` } }
  }
}
