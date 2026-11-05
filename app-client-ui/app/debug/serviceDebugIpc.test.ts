import { bindService } from '../shared/serviceIpcTestHarness'
import type { IpcMainInvokeEvent } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AppClientUiIpcInvokeMap } from '../../shared/appClientUiIpc'
import { ServiceDebugIpc } from './serviceDebugIpc'

const ipcMainMock = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  output: [] as string[],
}))

vi.mock('node:fs', () => ({ writeSync: (_fd: number, text: string) => { ipcMainMock.output.push(text) } }))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      ipcMainMock.handlers.set(channel, handler)
    },
  },
}))

describe('app-client-ui/app/debug/serviceDebugIpc', () => {
  const sections: (string | null)[] = []
  let service: ServiceDebugIpc

  beforeEach(() => {
    ipcMainMock.handlers.clear()
    sections.length = 0
    ipcMainMock.output.length = 0
    service = bindService(new ServiceDebugIpc({
      sectionActive: (_sender, section) => { sections.push(section) },
    }))
  })

  async function invoke(
    channel: keyof AppClientUiIpcInvokeMap,
    ...args: unknown[]
  ): Promise<unknown> {
    const handler = ipcMainMock.handlers.get(channel)
    if (!handler) throw new Error(`No handler for ${channel}`)
    return handler({} as IpcMainInvokeEvent, ...args)
  }

  it('registers a handler for every channel it declares', () => {
    service.initialize()
    expect([...ipcMainMock.handlers.keys()].sort())
      .toEqual(Object.keys(ServiceDebugIpc.channelsConst).sort())
  })

  // The two Host reads are the control API's `host.status` and `host.ping` now; what is left is the window.
  it('declares the section and the explicitly gated smoke block', () => {
    expect(Object.keys(ServiceDebugIpc.channelsConst)).toEqual(['debug:section-active', 'debug:block-loop'])
  })

  it.each(['orchestrator', 'main'])('refuses a forced %s block without --smoke before writing or blocking', async target => {
    const wait = vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out')
    try {
      service.initialize()
      expect(await invoke('debug:block-loop', { target, id: 'test', milliseconds: 3000 }))
        .toEqual({ ok: false, error: 'debug.blockLoop requires --smoke' })
      expect(ipcMainMock.output).toEqual([])
      expect(wait).not.toHaveBeenCalled()
    } finally { wait.mockRestore() }
  })

  it.each([3000, 20000])('forwards the %s ms block to the orchestration owner without blocking main', async milliseconds => {
    const wait = vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out')
    const block = vi.fn(async () => {})
    try {
      service = bindService(new ServiceDebugIpc({ sectionActive: () => {}, smoke: true, block }))
      service.initialize()
      const request = { target: 'orchestrator', id: 'test', milliseconds }
      expect(await invoke('debug:block-loop', request)).toEqual({ ok: true, value: undefined })
      expect(block).toHaveBeenCalledExactlyOnceWith(request)
      expect(wait).not.toHaveBeenCalled()
      expect(ipcMainMock.output).toEqual([])
    } finally { wait.mockRestore() }
  })

  it.each([null, {}, { target: 'future', id: 'test', milliseconds: 3000 },
    { target: 'main', id: 'test', milliseconds: 20000 },
    { target: 'orchestrator', milliseconds: 3000 },
    { target: 'orchestrator', id: null, milliseconds: 3000 },
    { target: 'orchestrator', id: 123, milliseconds: 3000 },
    { target: 'orchestrator', id: 'injected\nline', milliseconds: 3000 },
    { target: 'orchestrator', id: 'test', milliseconds: 20001 }])('refuses invalid smoke requests: %j', async request => {
    service = bindService(new ServiceDebugIpc({ sectionActive: () => {}, smoke: true }))
    service.initialize()
    expect(await invoke('debug:block-loop', request)).toEqual({ ok: false, error: 'Invalid smoke block request' })
    expect(ipcMainMock.output).toEqual([])
  })

  it('writes actual main PID entry before its 3000 ms block and exit afterward', async () => {
    const block = vi.fn(async () => {})
    const wait = vi.spyOn(Atomics, 'wait').mockImplementation((_array, _index, _value, milliseconds) => {
      expect(milliseconds).toBe(3000)
      expect(ipcMainMock.output.map(line => JSON.parse(line.slice('[latency-smoke] '.length)).phase)).toEqual(['start'])
      return 'timed-out'
    })
    try {
      service = bindService(new ServiceDebugIpc({ sectionActive: () => {}, smoke: true, block }))
      service.initialize()
      expect(await invoke('debug:block-loop', { target: 'main', id: 'main-block', milliseconds: 3000 })).toEqual({ ok: true, value: undefined })
      expect(wait).toHaveBeenCalledOnce()
      expect(block).not.toHaveBeenCalled()
      const receipts = ipcMainMock.output.map(line => JSON.parse(line.slice('[latency-smoke] '.length)))
      expect(receipts.map(row => row.phase)).toEqual(['start', 'end'])
      for (const row of receipts) {
        expect(row).toMatchObject({ kind: 'block', id: 'main-block', target: 'main', process: 'main', pid: process.pid, milliseconds: 3000 })
        expect(row.at).toBeGreaterThan(0)
      }
      expect(receipts[1].at).toBeGreaterThanOrEqual(receipts[0].at)
    } finally { wait.mockRestore() }
  })

  it('tells the ping gate which section is on screen', async () => {
    service.initialize()
    await invoke('debug:section-active', 'host')
    await invoke('debug:section-active', null)
    expect(sections).toEqual(['host', null])
  })
})
