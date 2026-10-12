import { beforeEach, describe, expect, it } from 'vitest'

import type { ConfigStore } from '../../../lib-orchestrator/configStore/configStore'
import type { ConfigOpResult } from '../../../lib-orchestrator/configStore/configStore.types'
import type { UiSettingsValue } from '../../shared/uiSettings'
import { RegistryBench } from '../remoteControl/fixtures/registryBench'
import { UiSettingsOperations } from './uiSettingsOperations'

describe('app-client-ui/app/uiSettings/uiSettingsOperations', () => {
  const storedConst: UiSettingsValue = {
    fontScalePercent: 115,
    fileViewerFontScalePercent: 130,
    terminalFontScalePercent: 90,
    terminalTheme: 'soft',
    scrollSpeedPercent: 200,
    terminalScrollSpeedPercent: 150,
  }
  let saveAnswer: ConfigOpResult
  let written: UiSettingsValue[]
  let changed: number
  let bench: RegistryBench

  /** What the store answers is decided per test; whether it writes is the library's own tests. */
  function storeUnderTest(): ConfigStore {
    return {
      readSection: () => storedConst,
      saveSection: (_spec: unknown, value: UiSettingsValue) => {
        written.push(value)
        return saveAnswer
      },
    } as unknown as ConfigStore
  }

  beforeEach(() => {
    saveAnswer = { ok: true }
    written = []
    changed = 0
    bench = new RegistryBench()
    new UiSettingsOperations(storeUnderTest(), () => { changed += 1 }).register(bench.registry)
  })

  it('registers a read and a write', () => {
    expect(bench.registry.names().sort()).toEqual(['uiSettings.get', 'uiSettings.save'])
    expect(bench.registry.isWrite('uiSettings.save')).toBe(true)
    expect(bench.registry.isWrite('uiSettings.get')).toBe(false)
  })

  it('answers the read with what the section holds', async () => {
    expect(await bench.call('uiSettings.get')).toEqual({ ok: true, value: storedConst })
  })

  it('tells the windows once, and only after the write went through', async () => {
    expect(await bench.call('uiSettings.save', { value: storedConst })).toEqual({ ok: true, value: {} })
    expect(written).toEqual([storedConst])
    expect(changed).toBe(1)
  })

  /*
   * The event says the stored value moved. Sending one for a write that did not happen would have
   * every window read the file and apply what it already had, which looks like the save worked.
   */
  it('says nothing when the config is latched, and names the code', async () => {
    saveAnswer = { ok: false, code: 'config-latched', detail: 'unreadable config' }

    expect(await bench.call('uiSettings.save', { value: storedConst })).toEqual({
      ok: false,
      error: { code: 'operation-failed', detail: 'unreadable config', data: { sourceCode: 'config-latched' } },
    })
    expect(changed).toBe(0)
  })

  it('says nothing when the section refuses the value', async () => {
    saveAnswer = { ok: false, code: 'invalid-section', detail: 'off the step' }

    expect(await bench.call('uiSettings.save', { value: { fontScalePercent: 112 } })).toMatchObject({
      ok: false,
      error: { data: { sourceCode: 'invalid-section' } },
    })
    expect(changed).toBe(0)
  })

  it('refuses a body that is not a value before the section sees it', async () => {
    expect(await bench.call('uiSettings.save', { value: 'big' })).toMatchObject({
      ok: false,
      error: { code: 'invalid-request', detail: 'value: must be an object' },
    })
    expect(written).toEqual([])
  })
})
