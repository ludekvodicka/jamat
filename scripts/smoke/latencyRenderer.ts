import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import { RemoteUiScenarios, type WorkspaceCdp } from './remoteUiScenarios'

type RendererCommand =
  | { type: 'marker'; attachId: string; endpoint: string | null; marker: string; command: string }
  | { type: 'projects'; endpoint: string }
  | { type: 'block'; id: string; target: 'orchestrator' | 'main'; milliseconds: 3000 | 20000 }
interface RendererResult { value: any; markerAt: number | null }

export class LatencyRenderer {
  private readonly server: WebSocketServer
  private socket: WebSocket | null
  private readonly pending: Map<string, { resolve(value: RendererResult): void; reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>; marker: boolean; markerAt: number | null; done: boolean; value: unknown }>

  constructor() {
    const path = `/${randomUUID()}`
    this.server = new WebSocketServer({ host: '127.0.0.1', port: 0, path, maxPayload: 65536,
      verifyClient: (info: { req: IncomingMessage }) => info.req.url === path && this.socket === null })
    this.socket = null
    this.pending = new Map()
    this.server.on('connection', socket => {
      if (this.socket) { socket.close(1008, 'One renderer only'); return }
      this.socket = socket
      socket.on('message', bytes => this.receive(bytes.toString()))
      socket.on('close', () => this.fail(new Error('Fixture renderer bridge closed')))
      socket.on('error', error => this.fail(error))
    })
  }

  async open(ui: WorkspaceCdp): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      if (this.server.address()) { resolve(); return }
      this.server.once('listening', resolve)
      this.server.once('error', reject)
    })
    const address = this.server.address()
    assert(address && typeof address !== 'string')
    await ui.call('Log.enable')
    await ui.call('Page.enable')
    const identity = await ui.bridge('window.appClient.appInfo()')
    const previous = (await ui.call('Page.getFrameTree')).frameTree.frame
    await ui.call('Page.setBypassCSP', { enabled: true })
    await ui.call('Page.reload')
    await RemoteUiScenarios.until(async () => {
      const current = (await ui.call('Page.getFrameTree')).frameTree.frame
      assert.equal(current.url, previous.url)
      return current.loaderId !== previous.loaderId
        && await ui.evaluate<boolean>('Boolean(window.appClient && document.querySelector(".dv-dockview"))')
    }, 'Owned renderer reloaded with fixture-only CSP bypass')
    assert.deepEqual(await ui.bridge('window.appClient.appInfo()'), identity, 'Reload must retain the verified private client identity')
    await ui.evaluate(`new Promise((opened, failed) => {
      const socket = new WebSocket(${JSON.stringify(`ws://127.0.0.1:${address.port}${this.server.options.path}`)});
      window.latencySmoke = new Map();
      const unwrap = result => { if (!result.ok) throw new Error(JSON.stringify(result)); return result.value; };
      const send = value => socket.send(JSON.stringify(value));
      const frame = (id, value) => {
        const state = window.latencySmoke.get(id);
        if (!state) return;
        let data = '';
        switch (value.type) {
          case 'terminal.attached': state.writer = value.writer; break;
          case 'terminal.status': state.status = value; break;
          case 'terminal.data': data = value.delta; break;
          case 'terminal.delta': data = value.data; break;
          case 'terminal.snapshot': case 'terminal.snapshot-start': case 'terminal.snapshot-chunk':
          case 'terminal.snapshot-end': case 'terminal.snapshot-complete': case 'terminal.resize': case 'terminal.exit': break;
          default: throw new Error('Unknown terminal frame: ' + value.type);
        }
        if (state.marker && data) {
          state.text = (state.text + data).slice(-8192);
          if (state.text.includes(state.marker)) { send({ id: state.requestId, type: 'marker' }); state.marker = null; }
        }
      };
      window.appClient.onTerminalFrame(frame);
      window.appClient.onRemoteTerminalFrame((_endpoint, id, value) => frame(id, value));
      socket.onmessage = async ({ data }) => {
        const { id, command } = JSON.parse(data);
        try {
          let value;
          switch (command.type) {
            case 'marker': {
              const state = window.latencySmoke.get(command.attachId);
              if (!state || state.marker) throw new Error('Missing or busy fixture attach');
              Object.assign(state, { marker: command.marker, requestId: id, text: '' });
              if (command.endpoint === null) value = unwrap(await window.appClient.terminal.input(command.attachId, command.command));
              else value = unwrap(unwrap(await window.appClient.remote.terminalInput(command.endpoint, command.attachId, command.command)));
              break;
            }
            case 'projects': value = unwrap(await window.appClient.remote.listProjects(command.endpoint, {})); break;
            case 'block': value = unwrap(await window.appClient.debug.blockLoop({ id: command.id, target: command.target, milliseconds: command.milliseconds })); break;
            default: throw new Error('Unknown fixture command: ' + command.type);
          }
          send({ id, type: 'done', value });
        } catch (error) { send({ id, type: 'error', error: String(error) }); }
      };
      socket.onopen = () => opened(true);
      socket.onerror = () => failed(new Error('Fixture renderer bridge failed'));
    })`).catch(error => { throw new Error(`${String(error)}; renderer diagnostics: ${ui.diagnostics.join('\n')}`) })
    assert(this.socket?.readyState === WebSocket.OPEN)
  }

  call(command: RendererCommand): Promise<RendererResult> {
    const socket = this.socket
    if (socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Fixture renderer bridge unavailable'))
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Fixture renderer ${command.type} timeout`)) }, 30000)
      this.pending.set(id, { resolve, reject, timer, marker: command.type === 'marker', markerAt: null, done: false, value: undefined })
      socket.send(JSON.stringify({ id, command }), error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(error) }
      })
    })
  }

  async close(): Promise<void> {
    this.fail(new Error('Fixture renderer bridge stopped'))
    for (const socket of this.server.clients) socket.terminate()
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Fixture renderer server did not stop')), 3000)
      this.server.close(error => { clearTimeout(timer); if (error) reject(error); else resolve() })
    })
  }

  private receive(text: string): void {
    try {
      const response = JSON.parse(text)
      const pending = this.pending.get(response.id)
      if (!pending) throw new Error('Unexpected fixture response')
      switch (response.type) {
        case 'marker':
          if (!pending.marker || pending.markerAt !== null) throw new Error('Unexpected fixture marker')
          pending.markerAt = Number(process.hrtime.bigint()) / 1e6
          break
        case 'done':
          if (pending.done) throw new Error('Duplicate fixture acknowledgement')
          pending.done = true; pending.value = response.value
          break
        case 'error':
          this.pending.delete(response.id); clearTimeout(pending.timer); pending.reject(new Error(response.error)); return
        default: throw new Error(`Unknown fixture response: ${response.type}`)
      }
      if (pending.done && (!pending.marker || pending.markerAt !== null)) {
        this.pending.delete(response.id)
        clearTimeout(pending.timer)
        pending.resolve({ value: pending.value, markerAt: pending.markerAt })
      }
    } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); this.socket?.terminate() }
  }

  private fail(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
  }
}
