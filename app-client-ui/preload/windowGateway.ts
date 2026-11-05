import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type { ProcessPowerMessage } from '../../lib-orchestrator/shared/processWire.types'
import { ProcessCalls } from '../../lib-orchestrator/shared/processCalls'
import type { WindowMessage } from '../../lib-orchestrator/shared/windowWire.types'
import type { IpcResult } from '../shared/appClientUiIpc'

type FrameListener = (...args: readonly unknown[]) => void | Promise<void>
type RendererPort = IpcRendererEvent['ports'][number]

export class WindowGateway {
  private readonly listeners: Map<string, Set<FrameListener>>
  private readonly waiting: Set<() => void>
  private readonly consuming: Set<Promise<void>>
  private port: RendererPort | null
  private calls: ProcessCalls | null
  private closed: boolean

  constructor() {
    this.listeners = new Map()
    this.waiting = new Set()
    this.consuming = new Set()
    this.port = null
    this.calls = null
    this.closed = false
    ipcRenderer.on('jamat:power', (_event, message: ProcessPowerMessage) => this.power(message))
    ipcRenderer.on('jamat:gateway-port', event => {
      if (event.ports.length !== 1) throw new Error('Gateway requires one window endpoint')
      this.connect(event.ports[0]!)
    })
  }

  async invoke(channel: string, ...args: readonly unknown[]): Promise<IpcResult<unknown>> {
    try {
      await this.ready()
      const calls = this.calls
      if (!calls) throw new Error('Gateway window connection is closed')
      return { ok: true, value: await calls.call(channel.startsWith('remote:') ? 'remote' : 'terminal', channel, [...args]) }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  }

  subscribe(channel: string, listener: FrameListener): () => void {
    if (channel !== 'terminal:frame' && channel !== 'remote:terminal-frame' && channel !== 'remote:changed')
      throw new Error(`Unknown gateway event: ${channel}`)
    let listeners = this.listeners.get(channel)
    if (!listeners) { listeners = new Set(); this.listeners.set(channel, listeners) }
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }

  private connect(port: RendererPort): void {
    this.close()
    this.closed = false
    this.port = port
    this.calls = new ProcessCalls({ send: message => port.postMessage(message),
      invoke: async () => { throw new Error('Renderer calls are not accepted') },
      event: (target, name, payload) => {
        if (target !== 'window' || name !== 'remote:changed' || !Array.isArray(payload) || payload.length !== 0)
          throw new Error('Unknown gateway window event')
        for (const listener of this.listeners.get(name) ?? [])
          void Promise.resolve().then(() => listener()).catch(error => console.error(error))
      }, report: message => console.error(message),
    })
    port.onmessage = ({ data }: { data: WindowMessage }) => {
      if (this.port !== port) return
      try { this.receive(port, data) }
      catch (error) { console.error(error); this.close() }
    }
    port.onmessageerror = () => { if (this.port === port) this.close() }
    port.addEventListener('close', () => { if (this.port === port) this.close() })
    port.start()
    for (const resolve of this.waiting) resolve()
    this.waiting.clear()
  }

  private power(message: ProcessPowerMessage): void {
    this.calls?.power(message)
  }

  private receive(port: RendererPort, message: WindowMessage): void {
    switch (message.type) {
      case 'power': this.power(message); return
      case 'alive': this.calls?.alive(); return
      case 'terminal-frame': case 'remote-terminal-frame': {
        const channel = message.type === 'terminal-frame' ? 'terminal:frame' : 'remote:terminal-frame'
        const args = message.type === 'terminal-frame' ? [message.attachId, message.frame] : [message.endpointId, message.attachId, message.frame]
        const work = Promise.allSettled([...(this.listeners.get(channel) ?? [])].map(async listener => listener(...args)))
          .then(results => {
            for (const result of results)
              if (result.status === 'rejected') console.error(result.reason)
              else if (result.status === 'fulfilled') continue
              else throw new Error(`Unknown listener result: ${JSON.stringify(result)}`)
            if (this.port === port) port.postMessage({ type: 'frame-received', generation: message.generation,
              sequence: message.sequence, ...(results.some(result => result.status === 'rejected') ? { failed: true as const } : {}) } satisfies WindowMessage)
          }).catch(error => { console.error(error); if (this.port === port) this.close() })
        this.consuming.add(work)
        void work.then(() => this.consuming.delete(work))
        return
      }
      case 'stream-truncated':
        void Promise.all([...this.consuming]).then(() => {
          if (this.port === port) port.postMessage({ type: 'stream-reset', generation: message.generation } satisfies WindowMessage)
        }).catch(error => { console.error(error); if (this.port === port) this.close() })
        return
      case 'call': case 'pending': case 'reply': case 'cancel': case 'received': case 'event':
        this.calls?.receive(message); return
      case 'frame-received': case 'stream-reset': throw new Error(`Unexpected gateway message: ${message.type}`)
      default: throw new Error(`Unknown gateway message: ${(message as { type: string }).type}`)
    }
  }

  private async ready(): Promise<void> {
    if (this.port) return
    if (this.closed) throw new Error('Gateway window connection is closed')
    let resolve!: () => void
    let timer!: ReturnType<typeof setTimeout>
    try {
      await new Promise<void>((done, reject) => {
        resolve = done
        this.waiting.add(resolve)
        timer = setTimeout(() => reject(new Error('Gateway window port did not arrive within 30 seconds')), 30_000)
      })
    } finally { clearTimeout(timer); this.waiting.delete(resolve) }
  }

  private close(): void {
    this.closed = true
    const port = this.port
    this.port = null
    this.calls?.close()
    this.calls = null
    this.consuming.clear()
    port?.close()
  }
}
