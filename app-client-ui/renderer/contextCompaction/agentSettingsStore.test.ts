import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentSettingsSaveResult, AgentSettingsValue } from '../../shared/agentSettings'
import type { IpcResult } from '../../shared/appClientUiIpc'
import { AgentSettingsStore, type AgentSettingsStorePorts } from './agentSettingsStore'

describe('app-client-ui/renderer/contextCompaction/agentSettingsStore', () => {
  const firstConst: AgentSettingsValue = {
    claude: { yolo: false },
    codex: { yolo: false },
  }
  const secondConst: AgentSettingsValue = {
    claude: { yolo: false, autoCompactEnabled: true },
    codex: { yolo: false },
  }
  let value: AgentSettingsValue
  let notify: (() => void) | null
  let settingsResult: IpcResult<AgentSettingsSaveResult>
  let sets: [string, boolean][]
  let reports: string[]
  let store: AgentSettingsStore

  beforeEach(() => {
    vi.useFakeTimers()
    value = firstConst
    notify = null
    settingsResult = { ok: true, value: { ok: true } }
    sets = []
    reports = []
    const ports: AgentSettingsStorePorts = {
      read: () => Promise.resolve({ ok: true, value }),
      subscribe: (onChanged) => {
        notify = onChanged
        return () => { notify = null }
      },
      setAutoCompact: (agentId, enabled) => {
        sets.push([agentId, enabled])
        return Promise.resolve(settingsResult)
      },
      reportError: (message) => reports.push(message),
    }
    store = new AgentSettingsStore(ports)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reads once, follows change events and publishes the latest value', async () => {
    const changes: AgentSettingsValue[] = []
    store.subscribe(() => {
      const current = store.current().value
      if (current !== null) changes.push(current)
    })
    store.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(store.current()).toEqual({ value: firstConst, error: null })

    value = secondConst
    notify?.()
    await vi.advanceTimersByTimeAsync(100)

    expect(store.current().value).toBe(secondConst)
    expect(changes).toEqual([firstConst, secondConst])
  })

  it('sets only the requested provider switch and refreshes after an accepted write', async () => {
    store.start()
    await vi.advanceTimersByTimeAsync(0)
    value = secondConst

    await expect(store.setAutoCompact('claude', true)).resolves.toEqual({ ok: true })
    expect(store.current().value?.claude.autoCompactEnabled).toBe(true)
    await vi.advanceTimersByTimeAsync(0)

    expect(sets).toEqual([['claude', true]])
    expect(store.current().value).toBe(secondConst)
  })

  it('returns domain and transport failures without changing the snapshot', async () => {
    store.start()
    await vi.advanceTimersByTimeAsync(0)
    settingsResult = {
      ok: true,
      value: { ok: false, code: 'section-damaged', detail: 'repair config.json' },
    }

    await expect(store.setAutoCompact('codex', true)).resolves.toEqual({
      ok: false,
      detail: 'repair config.json',
    })
    settingsResult = { ok: false, error: 'main process gone' }
    await expect(store.setAutoCompact('codex', false)).resolves.toEqual({
      ok: false,
      detail: 'main process gone',
    })
    expect(store.current().value).toBe(firstConst)
    expect(reports).toEqual([])
  })
})
