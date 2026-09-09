import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TerminalInputRegistry, type TerminalInputTarget } from './terminalInputRegistry'

describe('app-client-ui/renderer/shell/terminalInputRegistry', () => {
  function targetOf(live = true): {
    written: string[]
    focuses: string[]
    target: TerminalInputTarget
  } {
    const written: string[] = []
    const focuses: string[] = []
    return {
      written,
      focuses,
      target: {
        writable: () => live,
        write(data: string): boolean {
          if (!live) return false
          written.push(data)
          return true
        },
        focus(): void { focuses.push('focus') },
      },
    }
  }

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('inserts the exact text once without scheduling or adding Enter', () => {
    const registry = new TerminalInputRegistry()
    const panel = targetOf()
    registry.register('s-a', panel.target)

    expect(registry.insert('s-a', 'Q:\\Imports\\page 1.png')).toBe(true)
    expect(panel.focuses).toEqual(['focus'])
    expect(panel.written).toEqual(['Q:\\Imports\\page 1.png'])
    expect(vi.getTimerCount()).toBe(0)

    vi.advanceTimersByTime(1_000)
    expect(panel.written).toEqual(['Q:\\Imports\\page 1.png'])
  })

  it('can insert without stealing focus', () => {
    const registry = new TerminalInputRegistry()
    const panel = targetOf()
    registry.register('s-a', panel.target)

    expect(registry.insert('s-a', 'exact text', { focus: false })).toBe(true)
    expect(panel.focuses).toEqual([])
    expect(panel.written).toEqual(['exact text'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rechecks writability before focus and writes nothing when the target became read-only', () => {
    const registry = new TerminalInputRegistry()
    let writable = true
    const written: string[] = []
    const focuses: string[] = []
    registry.register('s-a', {
      writable: () => writable,
      write: (text) => { written.push(text); return true },
      focus: () => focuses.push('focus'),
    })

    expect(registry.has('s-a')).toBe(true)
    writable = false
    expect(registry.insert('s-a', 'exact text')).toBe(false)
    expect(focuses).toEqual([])
    expect(written).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('focuses the terminal, writes the text, and sends Enter after the paste settles', () => {
    const registry = new TerminalInputRegistry()
    const panel = targetOf()
    registry.register('s-a', panel.target)

    expect(registry.submit('s-a', '/compact')).toBe(true)
    expect(panel.focuses).toEqual(['focus'])
    expect(panel.written).toEqual(['/compact'])

    vi.advanceTimersByTime(99)
    expect(panel.written).toEqual(['/compact'])

    vi.advanceTimersByTime(1)
    expect(panel.written).toEqual(['/compact', '\r'])
  })

  it('can submit without stealing focus from the current terminal', () => {
    const registry = new TerminalInputRegistry()
    const panel = targetOf()
    registry.register('s-a', panel.target)

    expect(registry.has('s-a')).toBe(true)
    expect(registry.has('s-b')).toBe(false)
    expect(registry.submit('s-a', '/compact', { focus: false })).toBe(true)
    vi.advanceTimersByTime(100)

    expect(panel.written).toEqual(['/compact', '\r'])
    expect(panel.focuses).toEqual([])
  })

  // The one thing this window knows about the tab in front is its session; the attach id is minted
  // inside the panel, once per run of its effect, and is nothing the bar could name.
  it('writes to the session it was asked for and to no other', () => {
    const registry = new TerminalInputRegistry()
    const alpha = targetOf()
    const beta = targetOf()
    registry.register('s-a', alpha.target)
    registry.register('s-b', beta.target)

    registry.submit('s-b', '/compact')
    vi.advanceTimersByTime(100)

    expect(alpha.written).toEqual([])
    expect(alpha.focuses).toEqual([])
    expect(beta.written).toEqual(['/compact', '\r'])
    expect(beta.focuses).toEqual(['focus'])
  })

  it('says so and writes nothing when no panel holds that session', () => {
    const registry = new TerminalInputRegistry()
    const panel = targetOf()
    registry.register('s-a', panel.target)

    expect(registry.submit('s-nobody-has', '/compact')).toBe(false)
    expect(panel.written).toEqual([])
    expect(panel.focuses).toEqual([])
  })

  it('sends no Enter after a text the panel refused', () => {
    const registry = new TerminalInputRegistry()
    const panel = targetOf(false)
    registry.register('s-a', panel.target)

    expect(registry.has('s-a')).toBe(false)
    expect(registry.submit('s-a', '/compact')).toBe(false)
    vi.advanceTimersByTime(100)
    expect(panel.written).toEqual([])
    expect(panel.focuses).toEqual(['focus'])
  })

  it('writes nothing once the panel that registered has gone', () => {
    const registry = new TerminalInputRegistry()
    const panel = targetOf()
    const unregister = registry.register('s-a', panel.target)

    unregister()

    expect(registry.submit('s-a', '/compact')).toBe(false)
    expect(panel.written).toEqual([])
    expect(panel.focuses).toEqual([])
  })

  /**
   * The unmount of a panel and the mount of its replacement can land in that order - React tears the
   * old tree down after the new one is built - so an unregister that deleted BY KEY would take the
   * newer panel's registration with it and leave the session with no writer at all.
   */
  it('lets a late unregister retire its own entry alone', () => {
    const registry = new TerminalInputRegistry()
    const older = targetOf()
    const newer = targetOf()
    const retireOlder = registry.register('s-a', older.target)
    registry.register('s-a', newer.target)

    retireOlder()

    expect(registry.submit('s-a', '/compact')).toBe(true)
    vi.advanceTimersByTime(100)
    expect(newer.written).toEqual(['/compact', '\r'])
    expect(newer.focuses).toEqual(['focus'])
    expect(older.written).toEqual([])
  })

  /*
   * The opposite of what this asserted until 2026-08-24, and the reason it changed: the guard was
   * on the identity of the registered object, and the PANEL replaces that object far more often
   * than it unmounts. `TerminalPanel` re-registers whenever its send callback changes identity, and
   * that callback is keyed on the surface's status - so a reconnect, a moved lease or a read-only
   * flip inside the 100 ms window silently dropped the Enter and left the command sitting on the
   * line, typed and unsent.
   *
   * The text went to a SESSION, and the Enter belongs to whatever is showing that session now.
   */
  it('sends the delayed Enter to whatever holds the session now', () => {
    const registry = new TerminalInputRegistry()
    const older = targetOf()
    const newer = targetOf()
    registry.register('s-a', older.target)

    expect(registry.submit('s-a', '/compact')).toBe(true)
    registry.register('s-a', newer.target)
    vi.advanceTimersByTime(100)

    expect(older.written).toEqual(['/compact'])
    expect(newer.written).toEqual(['\r'])
  })

  it('sends no delayed Enter after the target unregisters', () => {
    const registry = new TerminalInputRegistry()
    const panel = targetOf()
    const unregister = registry.register('s-a', panel.target)

    expect(registry.submit('s-a', '/compact')).toBe(true)
    unregister()
    vi.advanceTimersByTime(100)

    expect(panel.written).toEqual(['/compact'])
  })
})
