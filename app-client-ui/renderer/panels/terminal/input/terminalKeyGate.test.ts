import { describe, expect, it } from 'vitest'

import { AppCommands } from '../../../../shared/commands'
import { TerminalKeyGate } from './terminalKeyGate'

describe('app-client-ui/renderer/panels/terminal/terminalKeyGate', () => {
  function keydown(key: string, modifiers?: Partial<KeyboardEventInit>): KeyboardEvent {
    return new KeyboardEvent('keydown', { key, ...modifiers })
  }

  /** The reverse of `acceleratorOf`: the keystroke Electron would have spelled that way. */
  function keydownOf(accelerator: string): KeyboardEvent {
    const parts = accelerator.split('+')
    const key = parts[parts.length - 1]
    return keydown(keyOf(key), {
      ctrlKey: parts.includes('Ctrl'),
      altKey: parts.includes('Alt'),
      shiftKey: parts.includes('Shift'),
      metaKey: parts.includes('Cmd'),
    })
  }

  /** The catalog spells a letter upper case; a keyboard event carries the character itself. */
  function keyOf(name: string): string {
    if (name === 'Space') return ' '
    if (name === 'Esc') return 'Escape'
    if (name === 'Up' || name === 'Down' || name === 'Left' || name === 'Right') return `Arrow${name}`
    return name
  }

  it('spells a keystroke the way the catalog spells an accelerator', () => {
    expect(TerminalKeyGate.acceleratorOf(keydown('t', { ctrlKey: true }))).toBe('Ctrl+T')
    expect(TerminalKeyGate.acceleratorOf(keydown('ArrowRight', { ctrlKey: true, shiftKey: true })))
      .toBe('Ctrl+Shift+Right')
    expect(TerminalKeyGate.acceleratorOf(keydown('b', { ctrlKey: true, altKey: true })))
      .toBe('Ctrl+Alt+B')
    expect(TerminalKeyGate.acceleratorOf(keydown(',', { ctrlKey: true }))).toBe('Ctrl+,')
    expect(TerminalKeyGate.acceleratorOf(keydown('F11'))).toBe('F11')
    expect(TerminalKeyGate.acceleratorOf(keydown('Escape'))).toBe('Esc')
    expect(TerminalKeyGate.acceleratorOf(keydown(' '))).toBe('Space')
  })

  it('spells no accelerator for a modifier on its own', () => {
    for (const key of ['Control', 'Alt', 'Shift', 'Meta'])
      expect(TerminalKeyGate.acceleratorOf(keydown(key, { ctrlKey: true }))).toBeNull()
  })

  /**
   * Every key, not six of them. Without this the byte still arrives: the native menu fires the
   * command whatever has the focus, so a terminal that also sent Ctrl+T would open a tab AND put
   * \x14 into the agent.
   *
   * It walks the catalog because a hand-written list is a list that ages: the version before this
   * one computed `claimed` and then asserted six literals, so a seventh accelerator was covered by
   * a variable that was only used to check it was not empty.
   */
  it('takes back every key a command claims, so it is delivered once', () => {
    const claimed = AppCommands.all()
      .filter((command) => command.accelerator !== undefined && command.terminalSafe)
    expect(claimed.length).toBeGreaterThan(0)

    for (const command of claimed) {
      const accelerator = command.accelerator
      if (accelerator === undefined) throw new Error('filtered above')
      expect(
        TerminalKeyGate.allowXterm(keydownOf(accelerator)),
        `${command.id} claims ${accelerator}`,
      ).toBe(false)
    }

    // A plain reading of what the walk above covers. Both launcher keys are named, and that is the
    // property the swappable pair rests on: the gate answers off the catalog, and the catalog claims
    // the same two keys whichever card each of them opens.
    expect(claimed.map((command) => command.accelerator))
      .to.include.members(['Ctrl+T', 'Ctrl+Shift+T', 'Ctrl+W', 'Ctrl+Shift+D', 'F11', 'F2'])
  })

  /**
   * Every reserved key reaches the terminal, and each is spelled the way the gate spells it - so a
   * reserved entry that no keystroke can ever produce would be caught here.
   *
   * What this does NOT prove is the guard inside `allowXterm` that answers for them, because the
   * design-time gate in `tokensGate.test.ts` keeps every command off the reserved list: with nothing
   * claiming those keys, the gate answers true one line earlier and the guard is unreachable. It is
   * the fallback for the day that gate is relaxed, and it can only be driven by a catalog that
   * breaks the other rule. Said out loud rather than dressed up as coverage.
   */
  it('leaves every reserved key to the terminal, spelled the way the gate spells it', () => {
    const reserved: readonly string[] = AppCommands.reservedTerminalKeysConst

    for (const accelerator of reserved) {
      expect(TerminalKeyGate.allowXterm(keydownOf(accelerator)), accelerator).toBe(true)
      expect(TerminalKeyGate.acceleratorOf(keydownOf(accelerator))).toBe(accelerator)
    }
  })

  it('leaves the terminal every key it cannot work without', () => {
    for (const event of [
      keydown('r', { ctrlKey: true }),
      keydown('j', { ctrlKey: true }),
      keydown('Enter', { ctrlKey: true }),
      keydown('Enter', { shiftKey: true }),
      keydown('c', { ctrlKey: true }),
      keydown('v', { ctrlKey: true }),
      keydown('C', { ctrlKey: true, shiftKey: true }),
      keydown('V', { ctrlKey: true, shiftKey: true }),
    ])
      expect(TerminalKeyGate.allowXterm(event)).toBe(true)
  })

  it('leaves ordinary typing alone', () => {
    for (const event of [
      keydown('a'),
      keydown('A', { shiftKey: true }),
      keydown('Enter'),
      keydown('Tab'),
      keydown('c', { ctrlKey: true }),
      keydown('ArrowUp'),
    ])
      expect(TerminalKeyGate.allowXterm(event)).toBe(true)
  })

  // xterm asks about keyup and keypress too, and answering those the same way would swallow the
  // release of a key whose press was already handled.
  it('answers only about a key going down', () => {
    const keyup = new KeyboardEvent('keyup', { key: 't', ctrlKey: true })
    expect(TerminalKeyGate.allowXterm(keyup)).toBe(true)
  })
})
