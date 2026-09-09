import { describe, expect, it, vi } from 'vitest'

import { AppCommands, type CommandDescriptor, type CommandId } from '../../shared/commands'
import type { WindowRole } from '../../shared/windowInfo'
import { CommandRegistry } from './commandRegistry'

describe('app-client-ui/renderer/commands/commandRegistry', () => {
  function rendererCommandIds(role: WindowRole = 'main'): CommandId[] {
    return AppCommands.rendererFor(role).map((descriptor) => descriptor.id)
  }

  function covered(role: WindowRole = 'main'): CommandRegistry {
    const registry = new CommandRegistry()
    for (const id of rendererCommandIds(role))
      registry.register(id, () => {})
    return registry
  }

  it('refuses a second handler for the same command', () => {
    const registry = new CommandRegistry()
    registry.register('tab.new', () => {})
    expect(() => registry.register('tab.new', () => {})).toThrow(/already registered/)
  })

  it('runs a registered handler exactly once and reports it handled', () => {
    const registry = new CommandRegistry()
    const handler = vi.fn()
    registry.register('tab.new', handler)
    expect(registry.execute('tab.new')).toBe('handled')
    expect(handler).toHaveBeenCalledTimes(1)
  })

  // Not a throw: this is the seam an attachCustomKeyEventHandler will read to hand the key on.
  it('passes an unregistered command through', () => {
    const registry = new CommandRegistry()
    expect(registry.execute('tab.close')).toBe('passthrough')
  })

  it('accepts a catalog whose renderer commands all have handlers', () => {
    expect(() => covered('main').assertCovers(AppCommands.rendererFor('main'))).not.toThrow()
    expect(() => covered('holder').assertCovers(AppCommands.rendererFor('holder'))).not.toThrow()
  })

  it('names every renderer command left without a handler', () => {
    const registry = new CommandRegistry()
    for (const id of rendererCommandIds().filter((id) => id !== 'tab.splitDown'))
      registry.register(id, () => {})
    expect(() => registry.assertCovers(AppCommands.rendererFor('main'))).toThrow(/tab\.splitDown/)
  })

  it('hands a command its declared value', () => {
    const registry = new CommandRegistry()
    const handler = vi.fn()
    registry.register('session.setColor', handler)

    expect(registry.execute('session.setColor', { color: 'teal' })).toBe('handled')
    expect(handler).toHaveBeenCalledWith({ color: 'teal' })
  })

  it('carries None as the absence of a colour rather than a word for it', () => {
    const registry = new CommandRegistry()
    const handler = vi.fn()
    registry.register('session.setColor', handler)

    registry.execute('session.setColor', { color: null })

    expect(handler).toHaveBeenCalledWith({ color: null })
  })

  /**
   * The bare overload no longer takes the whole `CommandId` union, so a command whose handler reads
   * a required field off its argument cannot be run with nothing. This is a COMPILE-time assertion:
   * `pnpm typecheck` fails if the `@ts-expect-error` stops being an error, which is what happens the
   * moment somebody widens the overload back to `CommandId`.
   */
  it('refuses, at the type, to run a valued command with no value', () => {
    const registry = new CommandRegistry()
    const handler = vi.fn()
    registry.register('session.setColor', handler)

    // @ts-expect-error a value-carrying command is not a `BareCommandId`
    registry.execute('session.setColor')

    // The runtime is unchanged - it never had a check of its own, and the type is now the check.
    expect(handler).toHaveBeenCalledWith(undefined)
  })

  /**
   * The optional explicit target: the tree sends the session of the clicked row, and the same
   * command called from the tab menu or the native menu still runs with nothing. Both spellings
   * compile against the one handler signature, which is the point of typing the argument
   * `{ sessionId?: string } | undefined` rather than making it a second command.
   */
  it('hands a session command its explicit target, and runs it without one', () => {
    const registry = new CommandRegistry()
    const handler = vi.fn()
    registry.register('session.restart', handler)

    expect(registry.execute('session.restart', { sessionId: 's-1' })).toBe('handled')
    expect(handler).toHaveBeenCalledWith({ sessionId: 's-1' })

    expect(registry.execute('session.restart')).toBe('handled')
    expect(handler).toHaveBeenLastCalledWith(undefined)
  })

  it('carries the colour and the clicked row it is for together', () => {
    const registry = new CommandRegistry()
    const handler = vi.fn()
    registry.register('session.setColor', handler)

    registry.execute('session.setColor', { color: 'teal', sessionId: 's-1' })

    expect(handler).toHaveBeenCalledWith({ color: 'teal', sessionId: 's-1' })
  })

  it('asks nothing of a main-process command', () => {
    const mainOnly: CommandDescriptor[] =
      AppCommands.all().filter((descriptor) => descriptor.id === 'app.reload')
    expect(mainOnly).toHaveLength(1)
    expect(() => new CommandRegistry().assertCovers(mainOnly)).not.toThrow()
  })
})
