import { beforeEach, describe, expect, it } from 'vitest'

import { TerminalDraftRegistry } from './terminalDraftRegistry'

describe('app-client-ui/renderer/shell/terminalDraftRegistry', () => {
  let clock: number
  let registry: TerminalDraftRegistry

  beforeEach(() => {
    clock = 1_000
    registry = new TerminalDraftRegistry(() => clock)
  })

  it('says nothing about a session nobody has typed into', () => {
    expect(registry.composing('session-1')).toBe(false)
  })

  it('holds a half-written line for as long as it stands', () => {
    registry.typed('session-1', 'hello')
    clock += 60_000

    expect(registry.composing('session-1')).toBe(true)
  })

  it('lets go once the line is submitted and the hands have left', () => {
    registry.typed('session-1', 'hello')
    registry.typed('session-1', '\r')
    expect(registry.composing('session-1')).toBe(true)

    clock += 15_000

    expect(registry.composing('session-1')).toBe(false)
  })

  /** A backspace that emptied the line leaves no characters, and still says where somebody is. */
  it('counts a keystroke that left nothing behind for a while after it', () => {
    registry.typed('session-1', 'a')
    registry.typed('session-1', '\x7f')
    clock += 14_999
    expect(registry.composing('session-1')).toBe(true)

    clock += 1

    expect(registry.composing('session-1')).toBe(false)
  })

  it('keeps one session out of another', () => {
    registry.typed('session-1', 'hello')
    clock += 60_000

    expect(registry.composing('session-1')).toBe(true)
    expect(registry.composing('session-2')).toBe(false)
  })

  it('ignores mouse, focus and device reports without inventing a draft or a typing delay', () => {
    for (const report of ['\x1b[<0;40;12M', '\x1b[<0;40;12m', '\x1b[>0;276;0c',
      '\x1b[1;20R', '\x1b[I', '\x1b]11;rgb:0000/0000/0000\x1b\\'])
      registry.typed('session-1', report)
    expect(registry.composing('session-1')).toBe(false)
    expect(registry.status('session-1')).toEqual({ characters: 0, quietAt: 0 })
  })

  it('keeps a real draft through reports and notifies the scheduler when Enter starts the quiet period', () => {
    let notifications = 0
    const off = registry.subscribe(() => { notifications += 1 })
    registry.typed('session-1', 'hello')
    registry.typed('session-1', '\x1b[<0;40;12M')
    expect(registry.status('session-1').characters).toBe(5)
    registry.typed('session-1', '\r')
    expect(registry.status('session-1')).toEqual({ characters: 0, quietAt: clock + 15_000 })
    expect(notifications).toBe(2)
    off()
    registry.typed('session-1', 'new draft')
    expect(notifications).toBe(2)
  })
})
