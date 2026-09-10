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
  function registry(): { commands: CommandRegistry; execute: ReturnType<typeof vi.spyOn> } {
    const commands = new CommandRegistry()
    return { commands, execute: vi.spyOn(commands, 'execute').mockReturnValue('handled') }
  }

  it('names the session for every command that takes one', () => {
    const ids: CommandId[] = [
      'session.details',
      'session.newBeside',
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

      SessionCommandRun.at(commands, id, 's1')

      expect(execute.mock.calls, id).toEqual([[id, { sessionId: 's1' }]])
    }
  })

  /*
   * The list is what a caller checks with `targets` before calling, so a command outside it arriving
   * here is a caller that did not ask - and running it bare would be exactly the late-bound target
   * this class exists to remove.
   */
  it('refuses a command that names no session rather than running it bare', () => {
    const { commands, execute } = registry()

    expect(() => SessionCommandRun.at(commands, 'tab.close', 's1'))
      .toThrow(/cannot be aimed at a session/)
    expect(execute).not.toHaveBeenCalled()
  })

  it('says which commands it can aim', () => {
    expect(SessionCommandRun.targets('session.restart')).toBe(true)
    expect(SessionCommandRun.targets('session.newBeside')).toBe(true)
    // A project row's command: it carries a place, and this class aims ids at a session.
    expect(SessionCommandRun.targets('session.newHere')).toBe(false)
    expect(SessionCommandRun.targets('tab.close')).toBe(false)
    expect(SessionCommandRun.targets('tab.resetLayout')).toBe(false)
    // Its own colour path: the menu passes the colour AND the session, so it is not aimed here.
    expect(SessionCommandRun.targets('session.setColor')).toBe(false)
  })
})
