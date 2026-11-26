import { ipcRenderer, type IpcRendererEvent } from 'electron'
import { ProcessCalls } from '../../lib-orchestrator/shared/processCalls'
import type { ProcessMessage, ProcessPowerMessage } from '../../lib-orchestrator/shared/processWire.types'
import { AppClientUiChannelOwnersConst } from '../shared/appClientUiIpc'
import type { AppClientUiIpcEventMap, IpcResult } from '../shared/appClientUiIpc'

type Listener = (...args: readonly unknown[]) => void | Promise<void>
type Port = IpcRendererEvent['ports'][number]

/**
 * The window's end of its private orchestration port. Like `WindowGateway`, each call waits up to 30 s
 * for a port, and a port that comes later is still taken: an orchestrator that started slowly on a
 * loaded machine used to leave the window refusing every call, session create included, until a reload.
 * A new port replaces a closed one.
 */
export class WindowOrchestrator {
  private static readonly portWaitMsConst = 30_000
  private readonly listeners: Map<string, Set<Listener>>
  private readonly waiting: Set<() => void>
  private closed: boolean
  private port: Port | null
  private calls: ProcessCalls | null

  constructor() {
    this.listeners = new Map()
    this.waiting = new Set()
    this.closed = false
    this.port = null
    this.calls = null
    ipcRenderer.on('jamat:power', (_event, message: ProcessPowerMessage) => this.power(message))
    ipcRenderer.on('jamat:orchestrator-port', event => {
      if (event.ports.length !== 1) throw new Error('Orchestrator requires exactly one window endpoint')
      this.connect(event.ports[0]!)
    })
  }
  async invoke(channel: string, ...args: readonly unknown[]): Promise<IpcResult<unknown>> {
    try {
      await this.ready()
      const calls = this.calls
      if (!calls) throw new Error('Orchestrator window connection is closed')
      return { ok: true, value: await calls.call('service', channel, [...args]) }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  }
  subscribe(channel: string, listener: Listener): () => void {
    if (AppClientUiChannelOwnersConst[channel as keyof AppClientUiIpcEventMap] !== 'orchestrator') throw new Error('Unknown orchestration event: ' + channel)
    const listeners = this.listeners.get(channel) ?? new Set<Listener>()
    this.listeners.set(channel, listeners)
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }
  private connect(port: Port): void {
    this.close()
    this.closed = false
    this.port = port
    this.calls = new ProcessCalls({ send: message => port.postMessage(message),
      invoke: async () => { throw new Error('Renderer requests are not accepted') },
      event: (target, name, payload) => {
        if (target !== 'window' || !Array.isArray(payload) || AppClientUiChannelOwnersConst[name as keyof AppClientUiIpcEventMap] !== 'orchestrator') throw new Error('Unknown orchestration window event')
        for (const listener of this.listeners.get(name) ?? []) void Promise.resolve().then(() => listener(...payload)).catch(error => console.error(error))
      }, report: message => console.error(message) })
    port.onmessage = ({ data }: { data: ProcessMessage }) => {
      if (this.port !== port) return
      try {
        switch (data.type) {
          case 'power': this.power(data); return
          case 'alive': this.calls?.alive(); return
          case 'call': case 'pending': case 'reply': case 'received': case 'cancel': case 'event': this.calls?.receive(data); return
          default: throw new Error('Unexpected orchestration window message: ' + data.type)
        }
      } catch (error) { console.error(error); if (this.port === port) this.close() }
    }
    port.onmessageerror = () => { if (this.port === port) this.close() }
    port.addEventListener('close', () => { if (this.port === port) this.close() })
    port.start()
    for (const resolve of this.waiting) resolve()
    this.waiting.clear()
  }
  private async ready(): Promise<void> {
    if (this.port) return
    if (this.closed) throw new Error('Orchestrator window connection is closed')
    let resolve!: () => void
    let timer!: ReturnType<typeof setTimeout>
    try {
      await new Promise<void>((done, reject) => {
        resolve = done
        this.waiting.add(resolve)
        timer = setTimeout(() => reject(new Error('Orchestrator window port did not arrive within 30 seconds')), WindowOrchestrator.portWaitMsConst)
      })
    } finally { clearTimeout(timer); this.waiting.delete(resolve) }
  }
  private power(message: ProcessPowerMessage): void {
    this.calls?.power(message)
  }
  private close(error = new Error('Orchestrator window connection is closed')): void {
    if (!this.port && !this.calls) return
    this.closed = true
    this.calls?.close(error)
    this.calls = null
    const port = this.port
    this.port = null
    port?.close()
  }
}
