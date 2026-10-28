import { z } from 'zod'
import { RemoteControlOutcome } from '../../../lib-orchestrator/remoteControl/remoteControlOutcome'
import type { RemoteControlRegistry } from '../../../lib-orchestrator/remoteControl/remoteControlRegistry'
import type { SnapinsManager } from '../../../lib-orchestrator/snapins/snapinsManager'
import type { AppOperationMap } from '../../shared/appOperationMap'
import type { ConfigStore } from '../../../lib-orchestrator/configStore/configStore'
import type { SnapinResult, SnapinsSettings } from '../../../lib-orchestrator/snapins/snapinsApi.types'
import { RemoteControlZod } from '../../../lib-orchestrator/remoteControl/remoteControlSchemas'
import { SnapinsSettingsSection } from './snapinsSettingsSection'

export class SnapinsOperations {
  private readonly manager: SnapinsManager
  private readonly configStore: Pick<ConfigStore, 'readSection' | 'saveSection'>

  constructor(manager: SnapinsManager, configStore: Pick<ConfigStore, 'readSection' | 'saveSection'>) {
    this.manager = manager
    this.configStore = configStore
  }

  register(registry: Pick<RemoteControlRegistry, 'registrar'>): void {
    const op = registry.registrar<AppOperationMap>()
    op('snapins.passWake', { kind: 'write', description: 'Wake the local pass inbox consumer.',
      input: z.strictObject({ passDirectory: z.string().min(1) }),
      run: async () => { this.manager.wake(); return { ok: true, value: { woken: true } } } })
    op('snapins.list', { kind: 'read', description: 'Built-in snap-ins and their current state.', input: z.strictObject({}),
      run: async () => ({ ok: true, value: this.manager.list() }) })
    op('snapins.view', { kind: 'read', description: 'Read one snap-in view.', input: z.strictObject({ kind: z.string().min(1) }),
      run: async (body) => RemoteControlOutcome.of(await this.manager.view(body.kind)) })
    op('snapins.press', { kind: 'write', description: 'Queue an action in one snap-in.',
      input: z.strictObject({ kind: z.string().min(1), actionId: z.string().min(1), itemKeys: z.array(z.string().min(1)).optional() }),
      run: async (body) => RemoteControlOutcome.of(await this.manager.press(body.kind, body.actionId, body.itemKeys)) })
    op('snapins.settings.get', { kind: 'read', description: 'Read common and per-kind snap-in settings.', input: z.strictObject({}),
      run: async () => ({ ok: true, value: await this.manager.settingsView() }) })
    op('snapins.settings.save', { kind: 'write', description: 'Save snap-in settings and wake the scheduler.',
      input: z.strictObject({ settings: RemoteControlZod.ownedObject<SnapinsSettings>() }),
      run: async (body) => RemoteControlOutcome.of(this.save(body.settings)) })
  }

  private save(settings: SnapinsSettings): SnapinResult<{ saved: true }> {
    const invalid = SnapinsSettingsSection.spec.validate(settings)
    if (invalid !== null) return { ok: false, code: 'invalid-settings', detail: invalid }
    const existing = this.configStore.readSection(SnapinsSettingsSection.spec)
    const known = new Set(this.manager.list().kinds.map((entry) => entry.kind))
    const unknown = Object.fromEntries(Object.entries(existing.kinds).filter(([kind]) => !known.has(kind)))
    const result = this.configStore.saveSection(SnapinsSettingsSection.spec, { ...settings, kinds: { ...settings.kinds, ...unknown } })
    if (!result.ok) {
      if (result.code === 'config-latched') return { ok: false, code: 'config-latched', detail: result.detail }
      else if (result.code === 'invalid-section') return { ok: false, code: 'invalid-settings', detail: result.detail }
      else throw new Error(`Unexpected snap-ins settings save result ${JSON.stringify(result)}`)
    }
    this.manager.wake()
    return { ok: true, value: { saved: true } }
  }
}
