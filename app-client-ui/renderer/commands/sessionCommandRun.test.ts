import { describe, expect, it, vi } from 'vitest'

import type { CommandId } from '../../shared/commands'
import { CommandRegistry } from './commandRegistry'
import { SessionCommandRun } from './sessionCommandRun'

/**
 * Running a menu command AT a named session.
 *
 * The sessions tree always did this - its rows are not the active tab. The tab menu ran everything
 * bare, which held only while the sole way to change the active panel was to click: a remote
 * controller activates another panel with no focus change, so the window's `blur` listener leaves
 * the menu standing and the next click lands on the session that arrived.
 */
describe('app-client-ui/renderer/commands/sessionCommandRun', () => {
  const placeConst = {
    kind: 'project' as const,
    project: {
      kind: 'project' as const,
      categoryId: 'c1',
      projectName: 'one',
      projectPath: 'Q:/one',
    },
  }

  function registry(): { commands: CommandRegistry; execute: ReturnType<typeof vi.spyOn> } {
    const commands = new CommandRegistry()
    return { commands, execute: vi.spyOn(commands, 'execute').mockReturnValue('handled') }
  }

  it('names the session for every command that takes one', () => {
    const ids: CommandId[] = [
      'session.details',
      'session.newBlank',
      'session.newInClaude',
      'session.newInCodex',
      'session.fork',
      'session.restart',
      'session.compact',
      'tab.openProjectFolder',
      'tab.copyProjectFolder',
      'session.copyReference',
      'tab.promote',
    ]
    for (const id of ids) {
      const { commands, execute } = registry()

      SessionCommandRun.at(commands, id, 's1', null)

      expect(execute.mock.calls, id).toEqual([[id, { sessionId: 's1' }]])
    }
  })

  it('carries a place for the launcher, which no session id can supply', () => {
    const { commands, execute } = registry()

    SessionCommandRun.at(commands, 'session.newHere', 's1', placeConst)

    expect(execute.mock.calls).toEqual([['session.newHere', { place: placeConst }]])
  })

  it('refuses to open the launcher beside a session that belongs to no project', () => {
    const { commands } = registry()

    expect(() => SessionCommandRun.at(commands, 'session.newHere', 's1', null))
      .toThrow(/no place/)
  })

  /*
   * The list is what a caller checks with `targets` before calling, so a command outside it arriving
   * here is a caller that did not ask - and running it bare would be exactly the late-bound target
   * this class exists to remove.
   */
  it('refuses a command that names no session rather than running it bare', () => {
    const { commands, execute } = registry()

    expect(() => SessionCommandRun.at(commands, 'tab.close', 's1', null))
      .toThrow(/cannot be aimed at a session/)
    expect(execute).not.toHaveBeenCalled()
  })

  it('says which commands it can aim', () => {
    expect(SessionCommandRun.targets('session.restart')).toBe(true)
    expect(SessionCommandRun.targets('session.newHere')).toBe(true)
    expect(SessionCommandRun.targets('tab.close')).toBe(false)
    expect(SessionCommandRun.targets('tab.resetLayout')).toBe(false)
    // Its own colour path: the menu passes the colour AND the session, so it is not aimed here.
    expect(SessionCommandRun.targets('session.setColor')).toBe(false)
  })
})
