import { describe, expect, it } from 'vitest'

import type { PanelOpenOutcome } from './appShell.types'
import type { OpenTerminalPort } from './sessionTabOpener'
import { SessionTabOpener } from './sessionTabOpener'

type OpenTerminalCall = {
  sessionId: string
  title: string
  options?: { preview?: true }
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

  it('says nothing when the tab opened', async () => {
    const port = opener({ kind: 'opened', panelId: 'p1' })

    expect(await SessionTabOpener.open(port.open, 's1', 'AppJamatV3 - 007')).toBeNull()
    expect(port.calls).toEqual([{ sessionId: 's1', title: 'AppJamatV3 - 007', options: undefined }])
  })

  // One session, one tab: focusing the tab that is already there is the same success.
  it('says nothing when an existing tab was focused instead', async () => {
    const port = opener({ kind: 'focusedExisting', panelId: 'p1', windowId: 'w1' })

    expect(await SessionTabOpener.open(port.open, 's1', 'title')).toBeNull()
  })

  /**
   * Reported and nothing more. The session has a row in the tree whatever happened to its tab, so
   * there is nothing stranded to clear up - which is what this did while a tab could be the only
   * place a session was drawn.
   */
  it('reports a tab that would not open, and clears nothing up', async () => {
    const port = opener({ kind: 'failed', detail: 'the workspace refused the panel' })

    expect(await SessionTabOpener.open(port.open, 's1', 'title'))
      .toBe('the workspace refused the panel')
  })

  it('treats a thrown open as a failure rather than letting it escape', async () => {
    const port = opener(new Error('dockview is gone'))

    expect(await SessionTabOpener.open(port.open, 's1', 'title')).toContain('dockview is gone')
  })

  it('refuses an outcome it does not know', async () => {
    const port = opener({ kind: 'exploded' } as unknown as PanelOpenOutcome)

    await expect(SessionTabOpener.open(port.open, 's1', 'title'))
      .rejects.toThrow(/Unknown panel open outcome/)
  })
})
