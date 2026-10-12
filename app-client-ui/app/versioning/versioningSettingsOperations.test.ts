import { beforeEach, describe, expect, it } from 'vitest'

import type { ConfigStore } from '../../../lib-orchestrator/configStore/configStore'
import type { ConfigOpResult } from '../../../lib-orchestrator/configStore/configStore.types'
import type { VersioningSettingsValue } from '../../shared/versioningSettings'
import { RegistryBench } from '../remoteControl/fixtures/registryBench'
import { VersioningSettingsOperations } from './versioningSettingsOperations'

describe('app-client-ui/app/versioning/versioningSettingsOperations', () => {
  const storedConst: VersioningSettingsValue = { mode: 'checkpoints', diffTool: { kind: 'internal' } }
  let answer: ConfigOpResult
  let written: VersioningSettingsValue[]
  let bench: RegistryBench

  beforeEach(() => {
    bench = new RegistryBench()
    answer = { ok: true }
    written = []
    new VersioningSettingsOperations({
      readSection: () => storedConst,
      saveSection: (_spec: unknown, value: VersioningSettingsValue) => {
        written.push(value)
        return answer
      },
    } as unknown as ConfigStore).register(bench.registry)
  })

  /** Each channel the window used to call, by the operation it is now. */
  async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    if (channel === 'versioning:settings-get') return bench.call('versioningSettings.get', {})
    if (channel === 'versioning:settings-save') return bench.call('versioningSettings.save', { value: args[0], ...(args[1] === undefined ? {} : { field: args[1] }) })
    throw new Error(`No operation for ${channel}`)
  }

  it('reads and writes only its config section', async () => {
    expect(await invoke('versioning:settings-get')).toEqual({ ok: true, value: storedConst })
    expect(await invoke('versioning:settings-save', { mode: 'git', diffTool: { kind: 'internal' } })).toEqual({
      ok: true,
      value: {},
    })
    expect(written).toEqual([{ mode: 'git', diffTool: { kind: 'internal' } }])
  })

  it('returns a strict section refusal as domain data', async () => {
    answer = { ok: false, code: 'invalid-section', detail: 'mode' }
    expect(await invoke('versioning:settings-save', { mode: 'jj' })).toEqual({
      ok: false,
      error: { code: 'operation-failed', detail: 'mode', data: { sourceCode: 'invalid-section' } },
    })
  })

  it('saves only the named field, preserving a mode changed since the diff section loaded', async () => {
    const diffTool = { kind: 'external', command: 'tool', argumentTemplate: '%base %mine' }
    await invoke('versioning:settings-save', { mode: 'git', diffTool }, 'diffTool')
    expect(written).toEqual([{ mode: 'checkpoints', diffTool }])
  })

  it('saves automatic closing without replacing another section from a stale settings buffer', async () => {
    await invoke('versioning:settings-save', { mode: 'git', diffTool: { kind: 'internal' }, activateSessionOnCommit: false, closeCommitOnSuccess: false }, 'closeCommitOnSuccess')
    expect(written).toEqual([{ ...storedConst, closeCommitOnSuccess: false }])
  })

  it('saves the commit split without replacing other versioning settings', async () => {
    await invoke('versioning:settings-save', { mode: 'git', diffTool: { kind: 'internal' }, commitSplitRatio: 0.45 }, 'commitSplitRatio')
    expect(written).toEqual([{ ...storedConst, commitSplitRatio: 0.45 }])
  })

  it('saves both review options atomically without replacing unrelated settings', async () => {
    await invoke('versioning:settings-save', { mode: 'git', diffTool: { kind: 'internal' },
      activateSessionOnCommit: true, returnToPreviousSessionAfterCommit: false, closeCommitOnSuccess: false }, 'commitReview')
    expect(written).toEqual([{ ...storedConst, activateSessionOnCommit: true, returnToPreviousSessionAfterCommit: false }])
  })

  it('keeps legacy single-field saves independent and rejects an unknown field', async () => {
    await invoke('versioning:settings-save', { ...storedConst, activateSessionOnCommit: false,
      returnToPreviousSessionAfterCommit: false }, 'activateSessionOnCommit')
    expect(written).toEqual([{ ...storedConst, activateSessionOnCommit: false }])
    expect(await invoke('versioning:settings-save', storedConst, 'unknown')).toMatchObject({
      ok: false, error: { code: 'invalid-request', detail: 'field: Unknown versioning setting' },
    })
    expect(written).toHaveLength(1)
  })
})
