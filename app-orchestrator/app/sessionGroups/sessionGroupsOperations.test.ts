import { beforeEach, describe, expect, it } from 'vitest'

import type { ConfigStore } from '../../../lib-orchestrator/configStore/configStore'
import type { ConfigOpResult } from '../../../lib-orchestrator/configStore/configStore.types'
import {
  SessionsGroupsState,
  type SessionGroupAssignment,
  type SessionGroupDefinition,
} from '../../../lib-orchestrator/clientApi/sessionsGroupsState'
import type { ShellSessionGroups } from '../../../lib-orchestrator/shared/shellPort.types'
import { RegistryBench } from '../remoteControl/fixtures/registryBench'
import { SessionGroupsOperations } from './sessionGroupsOperations'

describe('app-client-ui/app/sessionGroups/sessionGroupsOperations', () => {
  const keptConst: readonly SessionGroupDefinition[] = [
    { id: 'none', title: 'Sessions' },
    { id: 'pinned', title: 'Pinned' },
    { id: 'waiting', title: 'Waiting' },
  ]
  let saveAnswer: ConfigOpResult
  let written: (readonly SessionGroupDefinition[])[]
  let assignments: readonly SessionGroupAssignment[]
  let assignmentWrites: (readonly SessionGroupAssignment[])[]
  let assignmentsAccepted: boolean
  let changed: number
  let bench: RegistryBench

  function configUnderTest(): ConfigStore {
    return {
      readSection: () => SessionsGroupsState.defaultsConst,
      saveSection: (_spec: unknown, value: readonly SessionGroupDefinition[]) => {
        written.push(value)
        return saveAnswer
      },
    } as unknown as ConfigStore
  }

  function stateUnderTest(): ShellSessionGroups {
    return {
      assignments: () => assignments,
      onChanged: () => () => {},
      assign: async change => {
        if (change.kind !== 'prune') throw new Error('Unexpected assignment')
        const value = assignments.filter(item => item.group !== 'none' && change.groupIds.includes(item.group))
        if (value.length !== assignments.length) assignmentWrites.push(value)
        if (assignmentsAccepted) assignments = value
        return { ok: assignmentsAccepted, assignments }
      },
    }
  }

  beforeEach(() => {
    saveAnswer = { ok: true }
    written = []
    assignments = [
      { key: 'session:one', group: 'waiting' },
      { key: 'session:two', group: 'blocked' },
    ]
    assignmentWrites = []
    assignmentsAccepted = true
    changed = 0
    bench = new RegistryBench()
    new SessionGroupsOperations(configUnderTest(), stateUnderTest(), () => { changed += 1 }).register(bench.registry)
  })

  const save = () => bench.call('sessionGroups.save', { groups: keptConst })

  it('ensures a deleted waiting group without replacing other groups or their titles', async () => {
    const config = configUnderTest()
    config.readSection = (() => [{ id: 'none', title: 'Sessions' }, { id: 'pinned', title: 'Pinned' },
      { id: 'custom', title: 'My group' }]) as ConfigStore['readSection']
    const operations = new SessionGroupsOperations(config, stateUnderTest(), () => { changed++ })
    expect(await operations.ensure([{ id: 'waiting', title: 'Waiting' }])).toEqual({ ok: true })
    expect(written[0]).toEqual([{ id: 'none', title: 'Sessions' }, { id: 'pinned', title: 'Pinned' },
      { id: 'custom', title: 'My group' }, { id: 'waiting', title: 'Waiting' }])
    expect(changed).toBe(1)
  })

  it('preserves an assignment queued before pruning from an older pushed snapshot', async () => {
    const snapshot = structuredClone(assignments)
    let current = structuredClone(assignments)
    const queued: (() => void)[] = []
    let pruneQueued!: () => void
    const pruning = new Promise<void>(resolve => { pruneQueued = resolve })
    const store: ShellSessionGroups = {
      assignments: () => snapshot,
      onChanged: () => () => {},
      assign: change => new Promise(resolve => {
        queued.push(() => {
          if (change.kind === 'assign') current = SessionsGroupsState.assigned(current, change.key, change.group)
          else if (change.kind === 'replace') current = change.assignments
          else if (change.kind === 'prune') current = current.filter(item => item.group !== 'none' && change.groupIds.includes(item.group))
          else throw new Error('Unexpected fixture change')
          resolve({ ok: true, assignments: structuredClone(current) })
        })
        if (queued.length === 2) pruneQueued()
      }),
    }
    const registry = new RegistryBench()
    new SessionGroupsOperations(configUnderTest(), store, () => { changed += 1 }).register(registry.registry)
    const assigned = store.assign({ kind: 'assign', key: 'session:one', group: 'pinned' })
    const saved = registry.call('sessionGroups.save', { groups: keptConst })
    await pruning
    expect(snapshot).toEqual([{ key: 'session:one', group: 'waiting' }, { key: 'session:two', group: 'blocked' }])
    queued.shift()!()
    expect(await assigned).toEqual({ ok: true, assignments: [{ key: 'session:two', group: 'blocked' }, { key: 'session:one', group: 'pinned' }] })
    queued.shift()!()
    expect(await saved).toEqual({ ok: true, value: {} })
    expect(current).toEqual([{ key: 'session:one', group: 'pinned' }])
    expect(changed).toBe(1)
  })

  it('answers the read with the sections the config holds', async () => {
    expect(await bench.call('sessionGroups.list'))
      .toEqual({ ok: true, value: SessionsGroupsState.defaultsConst })
  })

  /*
   * The list and the assignments are two files, so a section removed here leaves keys naming it.
   * They go in the same call, before the event: no window may read a tree between the two writes
   * and find a session filed nowhere.
   */
  it('drops the assignments a removed section left behind, then tells the windows', async () => {
    expect(await save()).toEqual({ ok: true, value: {} })

    expect(written).toEqual([keptConst])
    expect(assignmentWrites).toEqual([[{ key: 'session:one', group: 'waiting' }]])
    expect(changed).toBe(1)
  })

  it('writes no assignments when every key still names a section', async () => {
    assignments = [{ key: 'session:one', group: 'waiting' }]

    expect(await save()).toEqual({ ok: true, value: {} })
    expect(assignmentWrites).toEqual([])
    expect(changed).toBe(1)
  })

  /*
   * The list IS stored by then. A client state that is not accepting writes leaves keys the tree
   * drops as it reads them, which is why this is not reported as a refused save.
   */
  it('keeps the saved list when the client state refuses the prune', async () => {
    assignmentsAccepted = false

    expect(await save()).toEqual({ ok: true, value: {} })
    expect(written).toEqual([keptConst])
    expect(changed).toBe(1)
  })

  it.each(['config-latched', 'invalid-section'] as const)(
    'says nothing and prunes nothing when the store answers %s', async (code) => {
      saveAnswer = { ok: false, code, detail: 'refused' }

      expect(await save())
        .toEqual({ ok: false, error: { code: 'operation-failed', detail: 'refused', data: { sourceCode: code } } })
      expect(assignmentWrites).toEqual([])
      expect(changed).toBe(0)
    },
  )

  /*
   * The section declares no `damaged`, so the store cannot answer that word here. If it ever could,
   * this wire type would have to learn it first rather than pass an unknown code to a window.
   */
  it('throws on a refusal this section cannot produce', async () => {
    saveAnswer = { ok: false, code: 'section-damaged', detail: 'hand edited' }

    // The throw reaches the caller as a failed operation, and the reason goes to the error report.
    expect(await save()).toMatchObject({ ok: false, error: { code: 'operation-failed' } })
    expect(bench.errors).toEqual([expect.stringContaining('Unexpected session groups save result')])
    expect(changed).toBe(0)
  })
})
