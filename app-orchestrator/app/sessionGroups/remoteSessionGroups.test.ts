import { describe, expect, it, vi } from 'vitest'
import { SessionsGroupsState } from '../../../lib-orchestrator/clientApi/sessionsGroupsState'
import type { ShellGroupAssignment, ShellSessionGroups } from '../../../lib-orchestrator/shared/shellPort.types'
import type { SessionInfo } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { RemoteSessionGroups } from './remoteSessionGroups'

const session = { sessionId: 'session-1', project: { kind: 'project', categoryId: 'code', projectPath: 'Q:/apps/one' } } as SessionInfo
const key = SessionsGroupsState.sessionKeyOf({ kind: 'local', sessionId: 'session-1' })

function fixture(initial: readonly ShellGroupAssignment[] = []) {
  let sections = [...SessionsGroupsState.defaultsConst]
  let listener: ((assignments: readonly ShellGroupAssignment[]) => void) | undefined
  const unsubscribe = vi.fn(() => { listener = undefined })
  const assign = vi.fn<ShellSessionGroups['assign']>(async () => ({ ok: true, assignments: [] }))
  const changed = vi.fn()
  const port = new RemoteSessionGroups(() => sections, {
    assignments: () => initial, assign,
    onChanged: next => { listener = next; return unsubscribe },
  }, changed)
  return { port, assign, changed, unsubscribe, sections: (value: typeof sections) => { sections = value },
    push: (value: readonly ShellGroupAssignment[]) => listener?.(value) }
}

describe('app-client-ui/app/sessionGroups/remoteSessionGroups', () => {
  it('exports current custom titles and ordering without exposing assignments or config', () => {
    const rig = fixture()
    const sections = [{ id: 'waiting', title: 'Na mě' }, { id: 'none', title: 'Sessions' }, { id: 'pinned', title: 'Pinned' }]
    rig.sections(sections)
    expect(rig.port.definitions()).toEqual(sections)
    expect(rig.port.definitions()).not.toBe(sections)
    rig.sections([sections[2], { id: 'waiting', title: 'Review' }, sections[1]])
    expect(rig.port.definitions().map(group => group.title)).toEqual(['Pinned', 'Review', 'Sessions'])
  })

  it('reads pushed effective groups with the tree precedence and prunes removed sections', () => {
    const rig = fixture()
    expect(rig.port.read([session]).get('session-1')).toBeNull()
    rig.push([{ key: 'category:code', group: 'priority' }])
    expect(rig.port.read([session]).get('session-1')).toBe('priority')
    const project = { key: 'project:category:code/q:/apps/one', group: 'automation' }
    rig.push([project])
    expect(rig.port.read([session]).get('session-1')).toBe('automation')
    rig.push([project, { key, group: 'waiting' }])
    expect(rig.port.read([session]).get('session-1')).toBe('waiting')
    rig.push([project, { key, group: 'none' }])
    expect(rig.port.read([session]).get('session-1')).toBe('automation')
    rig.push([{ key, group: 'removed-section' }])
    expect(rig.port.read([session]).get('session-1')).toBeNull()
    rig.push([{ key: 'root:adhoc', group: 'blocked' }, { key: 'root:none', group: 'completed' }])
    expect(rig.port.read([{ ...session, project: { kind: 'adHoc', path: 'Q:/scratch' } }]).get('session-1')).toBe('blocked')
    expect(rig.port.read([{ ...session, project: { kind: 'none' } }]).get('session-1')).toBe('completed')
  })

  it('files the session with the tree key, caches only a completed write and tells windows once', async () => {
    const rig = fixture([{ key, group: 'waiting' }])
    let complete!: (value: Awaited<ReturnType<ShellSessionGroups['assign']>>) => void
    rig.assign.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    const pending = rig.port.assign('session-1', 'completed')
    expect(rig.assign).toHaveBeenCalledExactlyOnceWith({ kind: 'assign', key, group: 'completed' })
    expect(rig.port.read([session]).get('session-1')).toBe('waiting')
    expect(rig.changed).not.toHaveBeenCalled()
    complete({ ok: true, assignments: [{ key, group: 'completed' }] })
    expect(await pending).toEqual({ ok: true, value: { group: 'completed' } })
    expect(rig.port.read([session]).get('session-1')).toBe('completed')
    expect(rig.changed).toHaveBeenCalledTimes(1)
    rig.assign.mockResolvedValueOnce({ ok: true, assignments: [] })
    expect(await rig.port.assign('session-1', 'none')).toEqual({ ok: true, value: { group: 'none' } })
    expect(rig.port.read([session]).get('session-1')).toBeNull()
  })

  it('refuses a well-formed id this computer has no section for and names the ones it has', async () => {
    const rig = fixture()
    expect(await rig.port.assign('session-1', 'invented-yesterday')).toEqual({ ok: false,
      error: { code: 'invalid-request', detail: 'This computer has no session group "invented-yesterday"; it has '
        + 'pinned, priority, none, automation, waiting, completed, blocked' } })
    expect(rig.assign).not.toHaveBeenCalled()
    expect(rig.changed).not.toHaveBeenCalled()
  })

  it('keeps the cache and sends no event when a write is refused or rejects', async () => {
    const rig = fixture([{ key, group: 'priority' }])
    rig.assign.mockResolvedValueOnce({ ok: false, assignments: [{ key, group: 'completed' }] })
    expect(await rig.port.assign('session-1', 'completed')).toEqual({ ok: false,
      error: { code: 'unavailable', detail: 'Client state is not accepting writes' } })
    expect(rig.port.read([session]).get('session-1')).toBe('priority')
    rig.assign.mockRejectedValueOnce(new Error('offline'))
    await expect(rig.port.assign('session-1', 'completed')).rejects.toThrow('offline')
    expect(rig.port.read([session]).get('session-1')).toBe('priority')
    expect(rig.changed).not.toHaveBeenCalled()
  })

  it('reads the sections again for every request', async () => {
    const rig = fixture()
    expect(await rig.port.assign('session-1', 'ship-it')).toMatchObject({ ok: false })
    rig.sections([...SessionsGroupsState.defaultsConst, { id: 'ship-it', title: 'Ship it' }])
    expect(await rig.port.assign('session-1', 'ship-it')).toEqual({ ok: true, value: { group: 'ship-it' } })
  })

  it('awaits inherited assignments and leaves a refused inheritance unchanged', async () => {
    const rig = fixture([{ key, group: 'priority' }])
    rig.assign.mockResolvedValueOnce({ ok: false, assignments: [] })
    await rig.port.inherit('parent', 'session-1')
    expect(rig.port.read([session]).get('session-1')).toBe('priority')
    expect(rig.changed).not.toHaveBeenCalled()
    rig.assign.mockResolvedValueOnce({ ok: true, assignments: [{ key, group: 'waiting' }] })
    await rig.port.inherit('parent', 'session-1')
    expect(rig.assign).toHaveBeenLastCalledWith({ kind: 'inherit', parentKey: 'session:parent', key })
    expect(rig.port.read([session]).get('session-1')).toBe('waiting')
    expect(rig.changed).toHaveBeenCalledTimes(1)
    rig.port.dispose()
    expect(rig.unsubscribe).toHaveBeenCalledTimes(1)
  })
  it.each(['assign', 'inherit'] as const)('retains a newer pushed snapshot after an older %s reply', async operation => {
    const rig = fixture([{ key, group: 'waiting' }])
    let complete!: (value: Awaited<ReturnType<ShellSessionGroups['assign']>>) => void
    rig.assign.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    let pending: Promise<unknown>
    if (operation === 'assign') pending = rig.port.assign('session-1', 'completed')
    else if (operation === 'inherit') pending = rig.port.inherit('parent', 'session-1')
    else throw new Error(`Unknown operation: ${operation satisfies never}`)
    rig.push([{ key, group: 'priority' }])
    complete({ ok: true, assignments: [{ key, group: 'completed' }] })
    await pending
    expect(rig.port.read([session]).get('session-1')).toBe('priority')
    expect(rig.changed).toHaveBeenCalledTimes(1)
  })

})
