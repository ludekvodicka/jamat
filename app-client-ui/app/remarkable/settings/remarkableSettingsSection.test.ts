import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ConfigStore } from '../../../../lib-orchestrator/configStore/configStore'
import { RemarkableSettings } from '../../../shared/remarkableSettings'
import { RemarkableSettingsSection } from './remarkableSettingsSection'

describe('app-client-ui/app/remarkable/settings/remarkableSettingsSection', () => {
  let root: string

  // This subsystem proves a path by realpath(p) === p, and os.tmpdir() is an 8.3 short

  // name on the Windows CI runner. Only the NATIVE call expands one, so a plain

  // realpathSync here would leave the root short and every such proof would refuse.

  beforeEach(() => { root = realpathSync.native(mkdtempSync(join(tmpdir(), 'jamat-v3-remarkable-settings-'))) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('owns remarkable and accepts exactly the shared model', () => {
    expect(RemarkableSettingsSection.spec.key).toBe('remarkable')
    expect(RemarkableSettingsSection.spec.validate(RemarkableSettings.defaultValue())).toBeNull()
    expect(RemarkableSettingsSection.spec.validate({ timeoutMilliseconds: 999 } as never))
      .toContain('timeoutMilliseconds')
    expect(RemarkableSettingsSection.spec.validate({
      fingerprint: 'SHA256:wrong',
      timeoutMilliseconds: 180_000,
    } as never)).toContain('SHA256')
  })

  it('preserves unknown fields inside and outside the section through ConfigStore save', () => {
    writeFileSync(join(root, 'config.json'), JSON.stringify({
      schemaVersion: 1,
      futureTopLevel: { keep: true },
      remarkable: {
        timeoutMilliseconds: 180_000,
        futureField: 'keep',
      },
    }), 'utf8')
    const store = ConfigStore.load(root, { snapshotsDirectory: join(root, 'snapshots') })
    const current = store.readSection(RemarkableSettingsSection.spec)

    expect(store.saveSection(RemarkableSettingsSection.spec, {
      ...current,
      host: 'remarkable.local',
    })).toEqual({ ok: true })
    expect(JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'))).toEqual({
      schemaVersion: 1,
      futureTopLevel: { keep: true },
      remarkable: {
        timeoutMilliseconds: 180_000,
        futureField: 'keep',
        host: 'remarkable.local',
      },
    })
  })

  it('refuses to overwrite a damaged present setting but not an incomplete section', () => {
    const configFile = join(root, 'config.json')
    const damaged = JSON.stringify({
      schemaVersion: 1,
      remarkable: { host: 'remarkable local', timeoutMilliseconds: 180_000 },
    })
    writeFileSync(configFile, damaged, 'utf8')
    const store = ConfigStore.load(root, { snapshotsDirectory: join(root, 'snapshots') })

    expect(store.saveSection(RemarkableSettingsSection.spec, RemarkableSettings.defaultValue()))
      .toEqual({ ok: false, code: 'section-damaged', detail: expect.any(String) })
    expect(readFileSync(configFile, 'utf8')).toBe(damaged)

    writeFileSync(configFile, JSON.stringify({ schemaVersion: 1, remarkable: {} }), 'utf8')
    const repairedStore = ConfigStore.load(root, { snapshotsDirectory: join(root, 'snapshots') })
    expect(repairedStore.saveSection(
      RemarkableSettingsSection.spec,
      RemarkableSettings.defaultValue(),
    ))
      .toEqual({ ok: true })
  })
})
