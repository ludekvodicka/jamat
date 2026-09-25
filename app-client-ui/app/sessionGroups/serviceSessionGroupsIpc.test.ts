import type { IpcMainInvokeEvent } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ConfigStore } from '../../../lib-orchestrator/configStore/configStore'
import type { ConfigOpResult } from '../../../lib-orchestrator/configStore/configStore.types'
import type { AppClientUiIpcInvokeMap } from '../../shared/appClientUiIpc'
import {
  SessionsGroupsState,
  type SessionGroupAssignment,
  type SessionGroupDefinition,
} from '../../shared/sessionsGroupsState'
import type { ClientStateStore } from '../clientState/clientStateStore'
import { ServiceSessionGroupsIpc } from './serviceSessionGroupsIpc'

const ipcMainMock = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      ipcMainMock.handlers.set(channel, handler)
    },
  },
}))

describe('app-client-ui/app/sessionGroups/serviceSessionGroupsIpc', () => {
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
  let service: ServiceSessionGroupsIpc

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
    ipcMainMock.handlers.clear()
    saveAnswer = { ok: true }
    written = []
    assignments = [
      { key: 'session:one', group: 'waiting' },
      { key: 'session:two', group: 'blocked' },
    ]
    assignmentWrites = []
    assignmentsAccepted = true
    changed = 0
    service = new ServiceSessionGroupsIpc(configUnderTest(), stateUnderTest(), () => { changed += 1 })
    service.initialize()
  })

  async function invoke(
    channel: keyof AppClientUiIpcInvokeMap,
    ...args: unknown[]
  ): Promise<unknown> {
    const handler = ipcMainMock.handlers.get(channel)
    if (!handler) throw new Error(`No handler for ${channel}`)
    return handler({} as IpcMainInvokeEvent, ...args)
  }

  it('registers a handler for every channel it declares', () => {
    expect([...ipcMainMock.handlers.keys()].sort())
      .toEqual(Object.keys(ServiceSessionGroupsIpc.channelsConst).sort())
  })

  it('fails the boot when one of its channels has no handler', () => {
    const internals = new ServiceSessionGroupsIpc(
      configUnderTest(), stateUnderTest(), () => {},
    ) as unknown as {
      assertComplete(channels: typeof ServiceSessionGroupsIpc.channelsConst): void
    }
    expect(() => internals.assertComplete(ServiceSessionGroupsIpc.channelsConst))
      .toThrow(/IPC channel is not registered/)
  })

  it('answers the read with the sections the config holds', async () => {
    expect(await invoke('session-groups:get'))
      .toEqual({ ok: true, value: SessionsGroupsState.defaultsConst })
  })

  /*
   * The list and the assignments are two files, so a section removed here leaves keys naming it.
   * They go in the same call, before the event: no window may read a tree between the two writes
   * and find a session filed nowhere.
   */
  it('drops the assignments a removed section left behind, then tells the windows', async () => {
    expect(await invoke('session-groups:save', keptConst)).toEqual({ ok: true, value: { ok: true } })

    expect(written).toEqual([keptConst])
    expect(assignmentWrites).toEqual([[{ key: 'session:one', group: 'waiting' }]])
    expect(changed).toBe(1)
  })

  it('writes no assignments when every key still names a section', async () => {
    assignments = [{ key: 'session:one', group: 'waiting' }]

    expect(await invoke('session-groups:save', keptConst)).toEqual({ ok: true, value: { ok: true } })
    expect(assignmentWrites).toEqual([])
    expect(changed).toBe(1)
  })

  /*
   * The list IS stored by then. A client state that is not accepting writes leaves keys the tree
   * drops as it reads them, which is why this is not reported as a refused save.
   */
  it('keeps the saved list when the client state refuses the prune', async () => {
    assignmentsAccepted = false

    expect(await invoke('session-groups:save', keptConst)).toEqual({ ok: true, value: { ok: true } })
    expect(written).toEqual([keptConst])
    expect(changed).toBe(1)
  })

  it.each(['config-latched', 'invalid-section'] as const)(
    'says nothing and prunes nothing when the store answers %s', async (code) => {
      saveAnswer = { ok: false, code, detail: 'refused' }

      expect(await invoke('session-groups:save', keptConst))
        .toEqual({ ok: true, value: { ok: false, code, detail: 'refused' } })
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

    // The throw reaches the renderer as a failed CALL rather than as a refusal it has to read.
    expect(await invoke('session-groups:save', keptConst)).toMatchObject({
      ok: false,
      error: expect.stringContaining('Unexpected session groups save result'),
    })
    expect(changed).toBe(0)
  })
})
