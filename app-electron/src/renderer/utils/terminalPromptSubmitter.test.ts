import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalPromptSubmitter } from './terminalPromptSubmitter'

// Verified: replacing the Win32 input record with raw CR reproduces Codex's unsubmitted newline.
describe('AppElectron/Src/Renderer/Utils/TerminalPromptSubmitter', () => {
  const cleanups: Array<() => void> = []

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.()
  })

  it('writes text and standard Enter separately', () => {
    const write = vi.fn()
    cleanups.push(TerminalPromptSubmitter.register('standard', {
      write,
      isWin32InputMode: () => false,
    }))

    expect(TerminalPromptSubmitter.submit('standard', '/compact')).toBe(true)
    expect(write.mock.calls).toEqual([['/compact'], ['\r']])
  })

  it('writes the xterm Win32 Enter input record when the mode is active', () => {
    const write = vi.fn()
    cleanups.push(TerminalPromptSubmitter.register('win32', {
      write,
      isWin32InputMode: () => true,
    }))

    expect(TerminalPromptSubmitter.submit('win32', '/compact')).toBe(true)
    expect(write.mock.calls).toEqual([['/compact'], ['\x1b[13;28;13;1;0;1_']])
  })

  it('does not let stale cleanup remove a newer binding', () => {
    const oldWrite = vi.fn()
    const newWrite = vi.fn()
    const removeOld = TerminalPromptSubmitter.register('reused', {
      write: oldWrite,
      isWin32InputMode: () => false,
    })
    const removeNew = TerminalPromptSubmitter.register('reused', {
      write: newWrite,
      isWin32InputMode: () => false,
    })
    cleanups.push(removeOld, removeNew)

    removeOld()
    expect(TerminalPromptSubmitter.submit('reused', 'next')).toBe(true)
    expect(oldWrite).not.toHaveBeenCalled()
    expect(newWrite.mock.calls).toEqual([['next'], ['\r']])
  })

  it('does nothing without a live terminal binding', () => {
    expect(TerminalPromptSubmitter.submit('missing', '/compact')).toBe(false)
  })
})
