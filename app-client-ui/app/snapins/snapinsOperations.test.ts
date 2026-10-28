import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SnapinsManager } from '../../../lib-orchestrator/snapins/snapinsManager'
import { RegistryBench } from '../remoteControl/fixtures/registryBench'
import { SnapinsOperations } from './snapinsOperations'
import { ConfigStore } from '../../../lib-orchestrator/configStore/configStore'
import { BuiltInSnapins } from '../../../lib-orchestrator/snapins/builtInSnapinsView'
import { SnapinsSettingsSection } from './snapinsSettingsSection'
import { PathCompare } from '../../../lib-orchestrator/shared/pathCompare'

describe('SnapinsOperations', () => {
  it('registers local reads and writes and returns the empty catalog and unknown-kind refusal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'snapins-ops-'))
    const manager = new SnapinsManager({ definitions: [], directory, onChanged: vi.fn(), report: vi.fn(),
      settings: () => ({ limit: 4, agents: ['claude'], workerPrompts: {}, kinds: {} }),
      ports: {} as ConstructorParameters<typeof SnapinsManager>[0]['ports'] })
    try {
      const bench = new RegistryBench()
      new SnapinsOperations(manager, ConfigStore.load(directory)).register(bench.registry)
      expect(await bench.call('snapins.list')).toEqual({ ok: true, value: { kinds: [] } })
      expect(await bench.call('snapins.view', { kind: 'gone' })).toMatchObject({ ok: false, error: { data: { sourceCode: 'unknown-kind' } } })
      expect(bench.registry.isWrite('snapins.press')).toBe(true)
      expect(await bench.call('snapins.press', { kind: 'gone', actionId: 'shared.refresh', extra: true })).toMatchObject({ ok: false })
      const wake = vi.spyOn(manager, 'wake').mockImplementation(() => {})
      expect(await bench.call('snapins.passWake', {})).toMatchObject({ ok: false })
      expect(await bench.call('snapins.passWake', { passDirectory: directory })).toEqual({ ok: true, value: { woken: true } })
      expect(wake).toHaveBeenCalledOnce()
    } finally {
      await manager.stop()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('reads defaults and built-in project fields, validates saves, preserves unknown values and wakes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'snapins-settings-'))
    const projectPath = join(directory, 'project')
    await mkdir(join(projectPath, '.aidocs/review-todos'), { recursive: true })
    const config = ConfigStore.load(directory, { snapshotsDirectory: join(directory, 'snapshots') })
    const manager = new SnapinsManager({ definitions: BuiltInSnapins.all(), directory, onChanged: vi.fn(), report: vi.fn(),
      settings: () => config.readSection(SnapinsSettingsSection.spec),
      ports: { projects: { projects: async () => [{ categoryId: 'code', categoryPath: directory, projectPath }] } } as ConstructorParameters<typeof SnapinsManager>[0]['ports'] })
    const wake = vi.spyOn(manager, 'wake').mockImplementation(() => {})
    const bench = new RegistryBench()
    new SnapinsOperations(manager, config).register(bench.registry)
    try {
      const defaults = config.readSection(SnapinsSettingsSection.spec)
      expect(await bench.call('snapins.settings.get')).toMatchObject({ ok: true, value: { settings: defaults,
        kinds: [{ kind: 'review-todos', fields: [{ kind: 'choicePerRow', id: 'modes', rows: [{ key: PathCompare.comparable(projectPath), value: 'wt' }] }] }] } })
      for (const limit of [0, 33]) {
        expect(await bench.call('snapins.settings.save', { settings: { ...defaults, limit } })).toMatchObject({ ok: false, error: { data: { sourceCode: 'invalid-settings' } } })
        expect(config.readSection(SnapinsSettingsSection.spec).limit).toBe(4)
      }
      expect(await bench.call('snapins.settings.save', { settings: { ...defaults, workerPrompts: { claude: 'work' } } }))
        .toMatchObject({ ok: false, error: { detail: expect.stringContaining('claude'), data: { sourceCode: 'invalid-settings' } } })
      expect(await bench.call('snapins.settings.save', { settings: { ...defaults, agents: ['claude', 'claude'] } })).toMatchObject({ ok: false })
      expect(await bench.call('snapins.settings.save', { settings: { ...defaults, kinds: { 'review-todos': { modes: { project: 'other' } } } } })).toMatchObject({ ok: false })
      expect(wake).not.toHaveBeenCalled()
      config.saveSection(SnapinsSettingsSection.spec, { ...defaults, kinds: { future: { answer: 'keep' } } })
      expect(await bench.call('snapins.settings.save', { settings: { ...defaults, limit: 2, workerPrompts: { claude: ' ' } } })).toEqual({ ok: true, value: { saved: true } })
      expect(wake).toHaveBeenCalledOnce()
      const reloaded = ConfigStore.load(directory).readSection(SnapinsSettingsSection.spec)
      expect(reloaded).toMatchObject({ limit: 2, workerPrompts: { claude: ' ' }, kinds: { future: { answer: 'keep' } } })
      expect(reloaded.agents.filter((id) => reloaded.workerPrompts[id]?.trim())).toEqual([])
    } finally { await manager.stop(); await rm(directory, { recursive: true, force: true }) }
  })
})
