import { randomUUID } from 'node:crypto'
import type { ProcessCallContext } from '../../../lib-orchestrator/shared/processCalls'
import type { TerminalGateway } from '../../../lib-orchestrator/sessionManager/terminalGateway'
import type { EditTransaction, InputInhibit, TerminalPort, TerminalSessionsFeed } from '../../../lib-orchestrator/sessionManager/terminalPort'
import type { TerminalProcessCall, TerminalProcessControl, TerminalProcessEvent } from '../../../lib-orchestrator/sessionManager/terminalProcess.types'

export class GatewayTerminalService {
  private readonly terminals: TerminalPort & TerminalSessionsFeed & Pick<TerminalGateway, 'closeAll'>
  private readonly emit: (event: TerminalProcessEvent) => void
  private readonly inhibits: Map<string, InputInhibit>
  private readonly transactions: Map<string, EditTransaction>
  private closed: boolean

  constructor(terminals: TerminalPort & TerminalSessionsFeed & Pick<TerminalGateway, 'closeAll'>,
    emit: (event: TerminalProcessEvent) => void) {
    this.terminals = terminals
    this.emit = emit
    this.inhibits = new Map()
    this.transactions = new Map()
    this.closed = false
  }

  async invoke(call: TerminalProcessCall, context: ProcessCallContext): Promise<unknown> {
    if (this.closed || context.signal.aborted) throw new Error('Gateway terminal service is closed or cancelled')
    switch (call.method) {
      case 'attach': {
        const [id, spec, owner] = call.args
        const cancelled = (): void => this.terminals.detach(id)
        context.signal.addEventListener('abort', cancelled, { once: true })
        const result = await this.terminals.attach(id, spec, { ...owner,
          onFrame: frame => this.emit({ name: 'frame', payload: { attachId: id, frame } }) })
        if (context.signal.aborted || this.closed) cancelled()
        return result
      }
      case 'input': {
        const [id, data] = call.args
        const cancelled = (): void => this.terminals.detach(id)
        context.signal.addEventListener('abort', cancelled, { once: true })
        context.pending()
        return this.terminals.input(id, data)
      }
      case 'resize': return this.terminals.resize(...call.args)
      case 'active': return this.terminals.setGeometryActive(...call.args)
      case 'authorize': return this.terminals.authorize(...call.args)
      case 'pendingInput': return this.terminals.pendingInput(...call.args)
      case 'publishRefs': return this.terminals.publishRefs(...call.args)
      case 'inhibit': {
        context.pending()
        const inhibit = await this.terminals.inhibit(...call.args)
        if (context.signal.aborted || this.closed) { inhibit.release(); throw new Error('Input inhibit cancelled') }
        const token = randomUUID()
        this.inhibits.set(token, inhibit)
        context.signal.addEventListener('abort', () => { this.inhibits.delete(token); inhibit.release() }, { once: true })
        return { token }
      }
      case 'transaction': {
        context.pending()
        const transaction = await this.terminals.transaction(...call.args)
        if ('refused' in transaction) return transaction
        if (context.signal.aborted || this.closed) { transaction.end(); throw new Error('Edit transaction cancelled') }
        const token = randomUUID()
        this.transactions.set(token, transaction)
        context.signal.addEventListener('abort', () => { this.transactions.delete(token); transaction.end() }, { once: true })
        return { token }
      }
      case 'write': {
        const [token, data] = call.args
        const transaction = this.transactions.get(token)
        if (!transaction) return { refused: 'disconnected' }
        const cancelled = (): void => { this.transactions.delete(token); transaction.end() }
        context.signal.addEventListener('abort', cancelled, { once: true })
        return transaction.write(data)
      }
      case 'close': this.stop(); return
      default: throw new Error(`Unknown terminal method: ${(call as { method: string }).method}`)
    }
  }

  control(event: TerminalProcessControl): void {
    switch (event.name) {
      case 'detach': this.terminals.detach(event.payload); return
      case 'release': {
        const inhibit = this.inhibits.get(event.payload)
        this.inhibits.delete(event.payload)
        inhibit?.release()
        return
      }
      case 'end': {
        const transaction = this.transactions.get(event.payload)
        this.transactions.delete(event.payload)
        transaction?.end()
        return
      }
      default: throw new Error(`Unknown terminal control: ${(event as { name: string }).name}`)
    }
  }

  stop(): void {
    if (this.closed) return
    this.closed = true
    // Detach first so releasing a hold during shutdown cannot replay its queued input.
    this.terminals.closeAll()
    for (const inhibit of this.inhibits.values()) inhibit.release()
    for (const transaction of this.transactions.values()) transaction.end()
    this.inhibits.clear()
    this.transactions.clear()
  }
}
