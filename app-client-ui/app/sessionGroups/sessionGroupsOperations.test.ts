import { beforeEach, describe, expect, it } from 'vitest'

import type { ConfigStore } from '../../../lib-orchestrator/configStore/configStore'
import type { ConfigOpResult } from '../../../lib-orchestrator/configStore/configStore.types'
import {
  SessionsGroupsState,
  type SessionGroupAssignment,
  type SessionGroupDefinition,
} from '../../shared/sessionsGroupsState'
import type { ClientStateStore } from '../clientState/clientStateStore'
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

  function stateUnderTest(): ClientStateStore {
    return {
      loadSessionGroups: () => assignments,
      saveSessionGroups: (value: readonly SessionGroupAssignment[]) => {
        assignmentWrites.push(value)
        if (assignmentsAccepted) assignments = value
        return assignmentsAccepted
      },
    } as unknown as ClientStateStore
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
