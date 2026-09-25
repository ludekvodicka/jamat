import { describe, expect, it } from 'vitest'

import { SessionsGroupsState, type SessionGroup } from '../../shared/sessionsGroupsState'
import type { ClientStateStore } from '../clientState/clientStateStore'
import { RemoteSessionGroups } from './remoteSessionGroups'
import type { SessionInfo } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'

describe('app-client-ui/app/sessionGroups/remoteSessionGroups', () => {
  it('reads current effective groups with the tree precedence and prunes removed sections', () => {
    const session: SessionInfo = {
      sessionId: 'session-1', kind: 'shell', title: 'Session', tabTitle: 'Session',
      titleParts: { number: null, name: 'Session' }, directory: { mode: 'default' },
      project: { kind: 'project', categoryId: 'code', projectPath: 'Q:/Apps/One', projectName: 'One' },
      life: 'live', activity: null, admits: [],
    }
    let assignments: { key: string; group: SessionGroup }[] = []
    const port = new RemoteSessionGroups(() => SessionsGroupsState.defaultsConst, {
      loadSessionGroups: () => assignments,
      assignSessionGroup: (key, group) => {
        assignments = [...SessionsGroupsState.assigned(assignments, key, group)]
        return true
      },
    }, () => {})

    expect(port.read([session]).get('session-1')).toBeNull()
    assignments = [{ key: 'category:code', group: 'priority' }]
    expect(port.read([session]).get('session-1')).toBe('priority')
    assignments.push({ key: 'project:category:code/q:/apps/one', group: 'automation' })
    expect(port.read([session]).get('session-1')).toBe('automation')
    expect(port.assign('session-1', 'waiting').ok).toBe(true)
    expect(port.read([session]).get('session-1')).toBe('waiting')
    expect(port.assign('session-1', 'none').ok).toBe(true)
    expect(port.read([session]).get('session-1')).toBeNull()
    assignments = [{ key: SessionsGroupsState.sessionKeyOf({ kind: 'local', sessionId: 'session-1' }), group: 'removed-section' }]
    expect(port.read([session]).get('session-1')).toBeNull()
    assignments = [{ key: 'root:adhoc', group: 'blocked' }, { key: 'root:none', group: 'completed' }]
    expect(port.read([{ ...session, project: { kind: 'adHoc', path: 'Q:/scratch' } }]).get('session-1')).toBe('blocked')
    expect(port.read([{ ...session, project: { kind: 'none' } }]).get('session-1')).toBe('completed')
  })

  function portUnderTest(options: { accepts?: boolean } = {}) {
    const written: { key: string; group: SessionGroup }[] = []
    const changes: number[] = []
    const store = {
      assignSessionGroup: (key: string, group: SessionGroup) => {
        written.push({ key, group })
        return options.accepts !== false
      },
    } as unknown as ClientStateStore
    const port = new RemoteSessionGroups(
      () => SessionsGroupsState.defaultsConst,
      store,
      () => changes.push(1),
    )
    return { changes, port, written }
  }

  /** The same key the tree's own menu writes, so a session a skill filed sits where a drag puts it. */
  it('files the session under the section and tells the windows once', () => {
    const { changes, port, written } = portUnderTest()

    expect(port.assign('session-1', 'completed')).toEqual({ ok: true, value: { group: 'completed' } })
    expect(written).toEqual([{
      key: SessionsGroupsState.sessionKeyOf({ kind: 'local', sessionId: 'session-1' }),
      group: 'completed',
    }])
    expect(changes).toHaveLength(1)
  })

  /*
   * The validator proved the id could BE a group and stopped there, because the sections are edited
   * on the computer that answers. So the refusal is here, and it names what this computer has: a
   * caller told only "no" has nothing to try next.
   */
  it('refuses a well-formed id this computer has no section for, and names the ones it has', () => {
    const { changes, port, written } = portUnderTest()

    expect(port.assign('session-1', 'invented-yesterday')).toEqual({
      ok: false,
      error: {
        code: 'invalid-request',
        detail: 'This computer has no session group "invented-yesterday"; it has '
          + 'pinned, priority, none, automation, waiting, completed, blocked',
      },
    })
    expect(written).toEqual([])
    expect(changes).toHaveLength(0)
  })

  it('says the state is unavailable when the write is refused, and tells no window', () => {
    const { changes, port } = portUnderTest({ accepts: false })

    expect(port.assign('session-1', 'waiting')).toEqual({
      ok: false,
      error: { code: 'unavailable', detail: 'Client state is not accepting writes' },
    })
    expect(changes).toHaveLength(0)
  })

  /** Read per call: a person may have added the section between two requests. */
  it('reads the sections again for every request', () => {
    let sections = [{ id: 'none', title: 'Sessions' }, { id: 'pinned', title: 'Pinned' }]
    const port = new RemoteSessionGroups(() => sections, {
      assignSessionGroup: () => true,
    } as unknown as ClientStateStore, () => {})

    expect(port.assign('session-1', 'ship-it')).toMatchObject({ ok: false })
    sections = [...sections, { id: 'ship-it', title: 'Ship it' }]
    expect(port.assign('session-1', 'ship-it')).toEqual({ ok: true, value: { group: 'ship-it' } })
  })
})
