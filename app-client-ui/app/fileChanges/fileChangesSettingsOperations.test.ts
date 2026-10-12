import { beforeEach, describe, expect, it } from 'vitest'

import type { ConfigStore } from '../../../lib-orchestrator/configStore/configStore'
import type { ConfigOpResult } from '../../../lib-orchestrator/configStore/configStore.types'
import type { FileChangesSettingsValue } from '../../shared/fileChangesSettings'
import { RegistryBench } from '../remoteControl/fixtures/registryBench'
import { FileChangesSettingsOperations } from './fileChangesSettingsOperations'

describe('app-client-ui/app/fileChanges/fileChangesSettingsOperations', () => {
  const storedConst: FileChangesSettingsValue = { primaryVcs: 'svn' }
  let answer: ConfigOpResult
  let written: FileChangesSettingsValue[]
  let bench: RegistryBench

  beforeEach(() => {
    answer = { ok: true }
    written = []
    bench = new RegistryBench()
    new FileChangesSettingsOperations({
      readSection: () => storedConst,
      saveSection: (_spec: unknown, value: FileChangesSettingsValue) => {
        written.push(value)
        return answer
      },
    } as unknown as ConfigStore).register(bench.registry)
  })

  it('reads and writes only its config section', async () => {
    expect(await bench.call('fileChangesSettings.get')).toEqual({ ok: true, value: storedConst })
    expect(await bench.call('fileChangesSettings.save', { value: { primaryVcs: 'git' } })).toEqual({ ok: true, value: {} })
    expect(written).toEqual([{ primaryVcs: 'git' }])
  })

  it('returns a strict section refusal with its own code', async () => {
    answer = { ok: false, code: 'invalid-section', detail: 'primaryVcs' }
    expect(await bench.call('fileChangesSettings.save', { value: { primaryVcs: 'hg' } })).toEqual({
      ok: false,
      error: { code: 'operation-failed', detail: 'primaryVcs', data: { sourceCode: 'invalid-section' } },
    })
  })
})
