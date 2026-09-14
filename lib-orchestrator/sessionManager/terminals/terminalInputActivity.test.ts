import { describe, expect, it } from 'vitest'
import { TerminalInputActivity } from './terminalInputActivity'

describe('lib-orchestrator/sessionManager/terminals/terminalInputActivity', () => {
  it.each([
    'a', 'příliš žluťoučký 🐎', '\r', '\t', '\x7f', '\x03', '\x1b',
    '\x1b[A', '\x1b[1;5D', '\x1b[3~', '\x1bOP', '\x1bf', '\x1b[13;2u',
    '\x1b[200~multi\nline\x1b[201~',
  ])('counts text, paste or a key: %j', (data) => {
    expect(TerminalInputActivity.isUserInput(data)).toBe(true)
  })

  it.each([
    '', '\x1b[I', '\x1b[O', '\x1b[0n', '\x1b[4;12R', '\x1b[?4;12R',
    '\x1b[?1;2c', '\x1b[>0;276;0c', '\x1b[8;30;120t', '\x1b[4;600;900t',
    '\x1b[?25;1$y', '\x1b[?997;1n', '\x1b[?0u',
    '\x1b]10;rgb:ffff/ffff/ffff\x1b\\', '\x1bP>|xterm.js(6.0.0)\x1b\\',
    '\x1b[<0;20;10M', '\x1b[M !!',
  ])('ignores automatic replies, focus and mouse reports: %j', (data) => {
    expect(TerminalInputActivity.isUserInput(data)).toBe(false)
  })
})
