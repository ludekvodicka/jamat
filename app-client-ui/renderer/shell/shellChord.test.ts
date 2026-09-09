import { describe, expect, it } from 'vitest'

import type { BareCommandId } from '../../shared/commands'
import { ShellChord } from './shellChord'

describe('app-client-ui/renderer/shell/shellChord', () => {
  class ChordTest {
    readonly ran: BareCommandId[] = []
    readonly chord: ShellChord
    private clock = 1_000

    constructor() {
      this.chord = new ShellChord((id) => this.ran.push(id), () => this.clock)
    }

    /** true = the chord took the stroke, which is what stops it reaching a focused terminal. */
    press(key: string, modifiers: { alt?: boolean; ctrl?: boolean; shift?: boolean } = {}): boolean {
      return this.chord.handle({
        key,
        altKey: modifiers.alt ?? false,
        ctrlKey: modifiers.ctrl ?? false,
        shiftKey: modifiers.shift ?? false,
        metaKey: false,
      } as KeyboardEvent)
    }

    advance(milliseconds: number): void {
      this.clock += milliseconds
    }
  }

  it('runs the move the second stroke names, and takes both strokes with it', () => {
    const test = new ChordTest()

    expect(test.press('t', { alt: true })).to.equal(true)
    expect(test.ran).to.deep.equal([])
    expect(test.press('n', { alt: true })).to.equal(true)

    expect(test.ran).to.deep.equal(['tab.moveRight'])
  })

  it('knows V1\'s four letters and nothing else', () => {
    const test = new ChordTest()
    for (const key of ['n', 'p', 'u', 'd']) {
      test.press('t', { alt: true })
      test.press(key, { alt: true })
    }

    expect(test.ran)
      .to.deep.equal(['tab.moveRight', 'tab.moveLeft', 'tab.moveUp', 'tab.moveDown'])
  })

  /**
   * The way the menu spells it is the way it is typed: Alt goes down once and stays down, so the
   * held modifier fires a keydown of its own between the two halves. Treating that as "something
   * else was pressed" would cancel every chord anybody actually types.
   */
  it('survives the keydown of the modifier being held', () => {
    const test = new ChordTest()

    test.press('t', { alt: true })
    expect(test.press('Alt', { alt: true })).to.equal(false)
    test.press('n', { alt: true })

    expect(test.ran).to.deep.equal(['tab.moveRight'])
  })

  it('lets a stroke that is not a direction through, and forgets the chord with it', () => {
    const test = new ChordTest()
    test.press('t', { alt: true })

    expect(test.press('x', { alt: true })).to.equal(false)
    expect(test.press('n', { alt: true })).to.equal(false)

    expect(test.ran).to.deep.equal([])
  })

  it('forgets a chord nobody finished', () => {
    const test = new ChordTest()
    test.press('t', { alt: true })
    test.advance(ShellChord.windowMillisecondsConst + 1)

    expect(test.press('n', { alt: true })).to.equal(false)

    expect(test.ran).to.deep.equal([])
  })

  it('arms again when the leader is pressed twice', () => {
    const test = new ChordTest()

    expect(test.press('t', { alt: true })).to.equal(true)
    expect(test.press('t', { alt: true })).to.equal(true)
    test.press('n', { alt: true })

    expect(test.ran).to.deep.equal(['tab.moveRight'])
  })

  /** Alt and nothing else: a key somebody else claimed has to travel, armed or not. */
  it('leaves a stroke carrying another modifier alone', () => {
    const test = new ChordTest()

    expect(test.press('t', { alt: true, ctrl: true })).to.equal(false)
    expect(test.press('t')).to.equal(false)
    test.press('t', { alt: true })
    expect(test.press('n', { alt: true, shift: true })).to.equal(false)

    expect(test.ran).to.deep.equal([])
  })

  it('never acts on a stroke with no chord open', () => {
    const test = new ChordTest()

    expect(test.press('n', { alt: true })).to.equal(false)

    expect(test.ran).to.deep.equal([])
  })
})
