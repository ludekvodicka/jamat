import type { IpcMainInvokeEvent } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ConfigStore } from '../../../lib-orchestrator/configStore/configStore'
import type { ConfigOpResult } from '../../../lib-orchestrator/configStore/configStore.types'
import type { AgentSettingsValue } from '../../shared/agentSettings'
import type { AppClientUiIpcInvokeMap } from '../../shared/appClientUiIpc'
import { ServiceAgentSettingsIpc } from './serviceAgentSettingsIpc'

const ipcMainMock = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) =>
      ipcMainMock.handlers.set(channel, handler),
  },
}))

describe('app-client-ui/app/agents/serviceAgentSettingsIpc', () => {
  const storedConst: AgentSettingsValue = { claude: { yolo: true }, codex: { yolo: false } }
  let answer: ConfigOpResult
  let written: AgentSettingsValue[]
  let stored: AgentSettingsValue
  let changed: number

  beforeEach(() => {
    ipcMainMock.handlers.clear()
    answer = { ok: true }
    written = []
    stored = storedConst
    changed = 0
    new ServiceAgentSettingsIpc({
      readSection: () => stored,
      saveSection: (_spec: unknown, value: AgentSettingsValue) => {
        written.push(value)
        if (answer.ok) stored = value
        return answer
      },
    } as unknown as ConfigStore, () => { changed += 1 }).initialize()
  })

  async function invoke(
    channel: keyof AppClientUiIpcInvokeMap,
    ...args: unknown[]
  ): Promise<unknown> {
    const handler = ipcMainMock.handlers.get(channel)
    if (!handler) throw new Error(`No handler for ${channel}`)
    return handler({} as IpcMainInvokeEvent, ...args)
  }

  it('reads and writes only its config section', async () => {
    expect(await invoke('agents:settings-get')).toEqual({ ok: true, value: storedConst })
    const saving: AgentSettingsValue = { claude: { yolo: false }, codex: { yolo: true } }
    expect(await invoke('agents:settings-save', saving)).toEqual({ ok: true, value: { ok: true } })
    expect(written).toEqual([saving])
    expect(changed).toBe(1)
  })

  it('sets one provider auto-compact switch over the latest stored section', async () => {
    stored = {
      claude: { yolo: true, model: 'opus', autoCompactPercent: 90 },
      codex: { yolo: false, effort: 'max', autoCompactEnabled: true },
    }

    expect(await invoke('agents:auto-compact-set', 'claude', true)).toEqual({
      ok: true,
      value: { ok: true },
    })
    expect(written).toEqual([{
      claude: {
        yolo: true,
        model: 'opus',
        autoCompactPercent: 90,
        autoCompactEnabled: true,
      },
      codex: { yolo: false, effort: 'max', autoCompactEnabled: true },
    }])
    expect(changed).toBe(1)
  })

  it('returns each section refusal as domain data', async () => {
    for (const code of ['config-latched', 'section-damaged', 'invalid-section'] as const) {
      answer = { ok: false, code, detail: `because ${code}` }
      expect(await invoke('agents:settings-save', storedConst)).toEqual({
        ok: true,
        value: { ok: false, code, detail: `because ${code}` },
      })
    }
    expect(changed).toBe(0)
  })
})
