import { describe, expect, it, vi } from 'vitest'

import type { PanelOpenOutcome } from './appShell.types'
import type { OpenTerminalPort } from './sessionTabOpener'
import { SessionTabOpener } from './sessionTabOpener'

type OpenTerminalCall = {
  sessionId: string
  title: string
  options?: { plain?: true; preview?: true }
}

describe('app-client-ui/renderer/shell/sessionTabOpener', () => {
  function opener(outcome: PanelOpenOutcome | Error): {
    open: OpenTerminalPort
    calls: OpenTerminalCall[]
  } {
    const calls: OpenTerminalCall[] = []
    return {
      calls,
      open: (sessionId, title, options) => {
        calls.push({ sessionId, title, options })
        return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome)
      },
    }
  }

  const neverCleans = {
    plain: false,
    closePlain: () => {
      throw new Error('A session of the tree has a row of its own; nothing is cleared up for it')
    },
  }

  it('says nothing when the tab opened', async () => {
    const port = opener({ kind: 'opened', panelId: 'p1' })

    expect(await SessionTabOpener.open(port.open, 's1', 'AppJamatV3 - 007', neverCleans))
      .toBeNull()
    expect(port.calls).toEqual([{ sessionId: 's1', title: 'AppJamatV3 - 007', options: undefined }])
  })

  // One session, one tab: focusing the tab that is already there is the same success.
  it('says nothing when an existing tab was focused instead', async () => {
    const port = opener({ kind: 'focusedExisting', panelId: 'p1', windowId: 'w1' })

    expect(await SessionTabOpener.open(port.open, 's1', 'title', neverCleans)).toBeNull()
  })

  it('asks for a plain tab when one was wanted', async () => {
    const port = opener({ kind: 'opened', panelId: 'p1' })

    await SessionTabOpener.open(port.open, 's1', 'title', {
      plain: true,
      closePlain: () => Promise.resolve(null),
    })

    expect(port.calls[0].options).toEqual({ plain: true })
  })

  it('reports a failure of a session of the tree and clears nothing up', async () => {
    const port = opener({ kind: 'failed', detail: 'the workspace refused the panel' })

    expect(await SessionTabOpener.open(port.open, 's1', 'title', neverCleans))
      .toBe('the workspace refused the panel')
  })

  /**
   * A plain tab is the only place its session is drawn, so one that never appeared would leave a
   * runtime nobody can see or stop.
   */
  it('closes the session behind a plain tab that never appeared', async () => {
    const port = opener({ kind: 'failed', detail: 'the workspace refused the panel' })
    const closePlain = vi.fn(() => Promise.resolve(null))

    expect(await SessionTabOpener.open(port.open, 's1', 'title', { plain: true, closePlain }))
      .toBe('the workspace refused the panel')
    expect(closePlain).toHaveBeenCalledWith('s1')
  })

  it('carries both halves when the clearing up failed too', async () => {
    const port = opener({ kind: 'failed', detail: 'the workspace refused the panel' })

    expect(await SessionTabOpener.open(port.open, 's1', 'title', {
      plain: true,
      closePlain: () => Promise.resolve('closing the unshown session was refused: live'),
    })).toBe('the workspace refused the panel; closing the unshown session was refused: live')
  })

  it('treats a thrown open as a failure rather than letting it escape', async () => {
    const port = opener(new Error('dockview is gone'))

    expect(await SessionTabOpener.open(port.open, 's1', 'title', neverCleans))
      .toContain('dockview is gone')
  })

  it('refuses an outcome it does not know', async () => {
    const port = opener({ kind: 'exploded' } as unknown as PanelOpenOutcome)

    await expect(SessionTabOpener.open(port.open, 's1', 'title', neverCleans))
      .rejects.toThrow(/Unknown panel open outcome/)
  })
})
