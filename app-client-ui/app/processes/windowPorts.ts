import type { ServiceCaller, ServiceCallerGoneReason } from '../../../lib-orchestrator/clientApi/serviceTransport.types'
import { MessageChannelMain, type MessagePortMain, type WebContents } from 'electron'
import type { ProcessPowerMessage } from '../../../lib-orchestrator/shared/processWire.types'
import { randomUUID } from 'node:crypto'
import type { RemoteWindowIdentity } from '../../../lib-orchestrator/remoteControl/remoteOutbound.types'

export class WindowPorts {
  private readonly orchestration: { open(caller: ServiceCaller, port: MessagePortMain, windowId: string): void; close(caller: ServiceCaller, reason: ServiceCallerGoneReason, windowId: string): void } | undefined
  private readonly lastCallers: Map<WebContents, ServiceCaller>
  private readonly open: (windowId: string, epoch: string, port: MessagePortMain, accepting: boolean) => void
  private readonly close: (windowId: string, epoch: string) => void
  private readonly updateAccepting: (windowId: string, epoch: string, accepting: boolean) => void
  private readonly acceptsRenderer: (sender: WebContents) => boolean
  private readonly authorizeAttach: (windowId: string, epoch: string, attachId: string) => Promise<string | null>
  private readonly report: (message: string) => void
  private readonly epochs: Map<WebContents, string>
  private readonly lifetimes: Map<WebContents, AbortController>
  private readonly watched: WeakSet<WebContents>
  private stopping: boolean

  constructor(deps: { open: WindowPorts['open']; close: WindowPorts['close'];
    setAccepting: WindowPorts['updateAccepting']; acceptsRenderer: WindowPorts['acceptsRenderer'];
    authorize: WindowPorts['authorizeAttach']; report: (message: string) => void; orchestration?: WindowPorts['orchestration'] }) {
    this.orchestration = deps.orchestration
    this.lastCallers = new Map()
    this.open = deps.open
    this.close = deps.close
    this.updateAccepting = deps.setAccepting
    this.acceptsRenderer = deps.acceptsRenderer
    this.authorizeAttach = deps.authorize
    this.report = deps.report
    this.epochs = new Map()
    this.lifetimes = new Map()
    this.watched = new WeakSet()
    this.stopping = false
  }

  watch(sender: WebContents, identity?: Pick<ServiceCaller, 'windowId' | 'role'>): void {
    if (this.watched.has(sender)) return
    this.watched.add(sender)
    sender.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (!inPlace && mainFrame) this.revoke(sender)
    })
    sender.on('render-process-gone', () => this.revoke(sender))
    sender.on('destroyed', () => { this.revoke(sender, 'closed'); this.lastCallers.delete(sender) })
    sender.on('did-finish-load', () => {
      this.revoke(sender)
      if (this.stopping || sender.isDestroyed()) return
      const epoch = randomUUID()
      const channel = new MessageChannelMain()
      const orchestration = this.orchestration && identity ? new MessageChannelMain() : null
      this.epochs.set(sender, epoch)
      this.lifetimes.set(sender, new AbortController())
      try {
        this.open(String(sender.id), epoch, channel.port1, this.acceptsRenderer(sender))
        sender.postMessage('jamat:gateway-port', { epoch }, [channel.port2])
        if (orchestration && identity) {
          const caller = { ...identity, id: epoch }
          this.lastCallers.set(sender, caller)
          this.orchestration!.open(caller, orchestration.port1, String(sender.id))
          sender.postMessage('jamat:orchestrator-port', { epoch }, [orchestration.port2])
        }
      } catch (error) {
        channel.port1.close()
        channel.port2.close()
        orchestration?.port1.close()
        orchestration?.port2.close()
        this.revoke(sender)
        this.report(String(error))
      }
    })
  }

  async authorize(sender: WebContents, attachId: string): Promise<string | null> {
    const epoch = this.epochs.get(sender)
    if (!epoch || sender.isDestroyed()) return null
    const result = await this.authorizeAttach(String(sender.id), epoch, attachId)
    return this.epochs.get(sender) === epoch && !sender.isDestroyed() ? result : null
  }

  identity(sender: WebContents): RemoteWindowIdentity | null {
    const epoch = this.epochs.get(sender)
    return epoch && !sender.isDestroyed() ? { windowId: String(sender.id), epoch } : null
  }

  sender(identity: RemoteWindowIdentity): WebContents | null {
    for (const [sender, epoch] of this.epochs)
      if (String(sender.id) === identity.windowId && epoch === identity.epoch && !sender.isDestroyed()) return sender
    return null
  }

  signal(identity: RemoteWindowIdentity): AbortSignal | null {
    const sender = this.sender(identity)
    return sender ? this.lifetimes.get(sender)?.signal ?? null : null
  }

  power(message: ProcessPowerMessage): void {
    for (const sender of this.epochs.keys())
      if (!sender.isDestroyed())
        try { sender.send('jamat:power', message) }
        catch (error) { this.report(String(error)); this.revoke(sender) }
  }

  stop(): void {
    this.stopping = true
    for (const sender of this.epochs.keys()) this.revoke(sender)
  }

  setAccepting(sender: WebContents, accepting: boolean): void {
    const epoch = this.epochs.get(sender)
    if (!epoch) return
    try { this.updateAccepting(String(sender.id), epoch, accepting) }
    catch (error) { this.report(String(error)); this.revoke(sender) }
  }

  private revoke(sender: WebContents, reason: ServiceCallerGoneReason = 'reload'): void {
    this.lifetimes.get(sender)?.abort()
    this.lifetimes.delete(sender)
    const epoch = this.epochs.get(sender)
    this.epochs.delete(sender)
    const caller = this.lastCallers.get(sender)
    if (caller && (epoch || reason === 'closed'))
      try { this.orchestration?.close(caller, reason, String(sender.id)) } catch (error) { this.report(String(error)) }
    if (!epoch) return
    try { this.close(String(sender.id), epoch) }
    catch (error) { this.report(String(error)) }
  }
}
