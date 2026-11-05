import { ipcRenderer, type IpcRendererEvent } from 'electron'
import { ProcessCalls } from '../../lib-orchestrator/shared/processCalls'
import type { ProcessMessage, ProcessPowerMessage } from '../../lib-orchestrator/shared/processWire.types'
import { AppClientUiChannelOwnersConst } from '../shared/appClientUiIpc'
import type { AppClientUiIpcEventMap, IpcResult } from '../shared/appClientUiIpc'

type Listener = (...args: readonly unknown[]) => void | Promise<void>
type Port = IpcRendererEvent['ports'][number]

export class WindowOrchestrator {
  private readonly listeners: Map<string, Set<Listener>>
  private readonly ready: Promise<void>
  private resolve!: () => void
  private reject!: (error: Error) => void
  private closed: boolean
  private port: Port | null
  private calls: ProcessCalls | null
  private timeout: ReturnType<typeof setTimeout> | null

  constructor() {
    this.listeners = new Map()
    this.closed = false
    this.port = null
    this.calls = null
    this.ready = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject })
    void this.ready.catch(() => {})
    this.timeout = setTimeout(() => this.close(new Error('Orchestrator window port did not arrive within 30 seconds')), 30_000)
    this.timeout.unref?.()
    ipcRenderer.on('jamat:power', (_event, message: ProcessPowerMessage) => this.power(message))
    ipcRenderer.on('jamat:orchestrator-port', event => {
      if (this.closed) { for (const port of event.ports) port.close(); return }
      if (event.ports.length !== 1 || this.port) throw new Error('Orchestrator requires exactly one window endpoint')
      this.connect(event.ports[0]!)
    })
  }
  async invoke(channel: string, ...args: readonly unknown[]): Promise<IpcResult<unknown>> {
    try {
      await this.ready
      if (!this.calls) throw new Error('Orchestrator window connection is closed')
      return { ok: true, value: await this.calls.call('service', channel, [...args]) }
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
    this.port = port
    if (this.timeout) clearTimeout(this.timeout)
    this.timeout = null
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
      } catch (error) { console.error(error); this.close() }
    }
    port.onmessageerror = () => this.close()
    port.addEventListener('close', () => this.close())
    port.start()
    this.resolve()
  }
  private power(message: ProcessPowerMessage): void {
    this.calls?.power(message)
  }
  private close(error = new Error('Orchestrator window connection is closed')): void {
    if (this.closed) return
    this.closed = true
    this.reject(error)
    if (this.timeout) clearTimeout(this.timeout)
    this.timeout = null
    this.calls?.close(error)
    this.calls = null
    const port = this.port
    this.port = null
    port?.close()
  }
}
