import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ConfigStore } from '../../../lib-orchestrator/configStore/configStore'
import type { SessionGroupAssignment, SessionGroupDefinition } from '../../../lib-orchestrator/clientApi/sessionsGroupsState'
import type { ShellSessionGroups } from '../../../lib-orchestrator/shared/shellPort.types'
import { AutomationGroupsCleanup } from './automationGroupsCleanup'
import { SessionGroupsOperations } from './sessionGroupsOperations'

describe('app-orchestrator/app/sessionGroups/automationGroupsCleanup', () => {
  const storedWithFourConst: readonly SessionGroupDefinition[] = [
    { id: 'pinned', title: 'Pinned' },
    { id: 'review', title: 'Review' },
    { id: 'none', title: 'Sessions' },
    { id: 'automation', title: 'Automation' },
    { id: 'waiting', title: 'Waiting' },
    { id: 'completed', title: 'Completed' },
    { id: 'blocked', title: 'Blocked' },
  ]
  let root: string
  let assignments: readonly SessionGroupAssignment[]
  let prunes: number
  let logs: string[]
  let reports: string[]

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'jamat-v3-automation-groups-'))
    assignments = []
    prunes = 0
    logs = []
    reports = []
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  const configFile = () => join(root, 'config.json')
  const storeList = (groups: readonly SessionGroupDefinition[]) =>
    writeFileSync(configFile(), JSON.stringify({ schemaVersion: 1, sessionGroups: groups }))

  function shellGroups(): ShellSessionGroups {
    return {
      assignments: () => assignments,
      onChanged: () => () => {},
      assign: async (change) => {
        if (change.kind !== 'prune') throw new Error('Unexpected assignment change')
        prunes += 1
        assignments = assignments.filter((item) => item.group !== 'none' && change.groupIds.includes(item.group))
        return { ok: true, assignments }
      },
    }
  }

  function cleanup(configStore = ConfigStore.load(root, { snapshotsDirectory: join(root, 'snapshots'), report: (message) => reports.push(message) })): AutomationGroupsCleanup {
    const shell = shellGroups()
    return new AutomationGroupsCleanup({
      assignments: shell,
      sections: new SessionGroupsOperations(configStore, shell, () => {}),
      log: (message) => logs.push(message),
      report: (message) => reports.push(message),
    })
  }

  it('removes the four from a stored list, keeps the custom section and prunes their assignments', async () => {
    storeList(storedWithFourConst)
    assignments = [
      { key: 'session:one', group: 'waiting' },
      { key: 'project:category:nodejs/q:/work', group: 'automation' },
      { key: 'session:two', group: 'review' },
    ]

    await cleanup().start()

    expect(JSON.parse(readFileSync(configFile(), 'utf8')).sessionGroups).toEqual([
      { id: 'pinned', title: 'Pinned' }, { id: 'review', title: 'Review' }, { id: 'none', title: 'Sessions' },
    ])
    expect(assignments).toEqual([{ key: 'session:two', group: 'review' }])
    expect(logs).toEqual(['automation groups cleanup: removed 4 stored sections, pruned 2 assignments'])
    expect(reports).toEqual([])
  })

  /*
   * Most computers never stored `sessionGroups`: the four came from the defaults. Their assignments
   * are pruned all the same, and no list is written for them.
   */
  it('prunes the assignments on a computer with the defaults only, writing no config', async () => {
    assignments = [{ key: 'session:one', group: 'blocked' }, { key: 'category:nodejs', group: 'priority' }]

    expect(await cleanup().run()).toEqual({ ok: true, removedSections: 0, prunedAssignments: 1 })
    expect(existsSync(configFile())).toBe(false)
    expect(assignments).toEqual([{ key: 'category:nodejs', group: 'priority' }])
    expect(prunes).toBe(1)
  })

  it('writes nothing and logs nothing when neither the list nor an assignment holds one of the four', async () => {
    storeList([{ id: 'pinned', title: 'Pinned' }, { id: 'none', title: 'Sessions' }, { id: 'review', title: 'Review' }])
    const before = readFileSync(configFile(), 'utf8')
    assignments = [{ key: 'session:one', group: 'review' }]

    await cleanup().start()

    expect(readFileSync(configFile(), 'utf8')).toBe(before)
    expect(existsSync(join(root, 'snapshots'))).toBe(false)
    expect(prunes).toBe(0)
    expect(assignments).toEqual([{ key: 'session:one', group: 'review' }])
    expect(logs).toEqual([])
  })

  it('keeps the assignments and reports when the list cannot be saved, so the next start retries', async () => {
    storeList(storedWithFourConst)
    const latched = ConfigStore.load(root, { snapshotsDirectory: join(root, 'snapshots'), report: () => {} })
    latched.saveSection = () => ({ ok: false, code: 'config-latched', detail: 'config.json is latched' })
    assignments = [{ key: 'session:one', group: 'waiting' }]

    await cleanup(latched).start()

    expect(JSON.parse(readFileSync(configFile(), 'utf8')).sessionGroups).toEqual(storedWithFourConst)
    expect(assignments).toEqual([{ key: 'session:one', group: 'waiting' }])
    expect(prunes).toBe(0)
    expect(logs).toEqual([])
    expect(reports).toEqual(['Automation groups cleanup stopped, the next start tries again: config.json is latched'])
  })

  it('changes nothing on a second run after a successful one', async () => {
    storeList(storedWithFourConst)
    assignments = [{ key: 'session:one', group: 'completed' }, { key: 'session:two', group: 'review' }]
    await cleanup().start()
    const config = readFileSync(configFile(), 'utf8')
    const held = structuredClone(assignments)
    prunes = 0
    logs = []

    expect(await cleanup().run()).toEqual({ ok: true, removedSections: 0, prunedAssignments: 0 })
    await cleanup().start()
    expect(readFileSync(configFile(), 'utf8')).toBe(config)
    expect(assignments).toEqual(held)
    expect(prunes).toBe(0)
    expect(logs).toEqual([])
  })

  it('reports a refused prune and leaves the assignments for the next start', async () => {
    assignments = [{ key: 'session:one', group: 'automation' }]
    const shell = shellGroups()
    const refusing = new AutomationGroupsCleanup({
      assignments: { assignments: shell.assignments, assign: async () => ({ ok: false, assignments }) },
      sections: new SessionGroupsOperations(ConfigStore.load(root, { snapshotsDirectory: join(root, 'snapshots') }), shell, () => {}),
      log: (message) => logs.push(message),
      report: (message) => reports.push(message),
    })

    await refusing.start()

    expect(assignments).toEqual([{ key: 'session:one', group: 'automation' }])
    expect(reports).toHaveLength(1)
    expect(logs).toEqual([])
  })
})
