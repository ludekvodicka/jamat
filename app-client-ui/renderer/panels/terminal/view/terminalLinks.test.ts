import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AppClientUiBridge } from '../../../../shared/appClientUiIpc'
import { TerminalLinks } from './terminalLinks'

describe('app-client-ui/renderer/panels/terminal/view/terminalLinks', () => {
  const opened: string[] = []
  let answer: { ok: true; value: boolean } | { ok: false; error: string }

  beforeEach(() => {
    opened.length = 0
    answer = { ok: true, value: true }
    const bridge = {
      fileViewer: {
        openExternal: (url: string) => {
          opened.push(url)
          return Promise.resolve(answer)
        },
      },
    }
    ;(window as unknown as { appClient: AppClientUiBridge })
      .appClient = bridge as unknown as AppClientUiBridge
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete (window as unknown as { appClient?: unknown }).appClient
  })

  const activate = (url: string): void =>
    TerminalLinks.handlerConst.activate(new MouseEvent('click'), url, {
      start: { x: 1, y: 1 },
      end: { x: 1, y: 1 },
    })

  /**
   * The handler exists only because xterm's own asks a question it cannot act on: its `window.open`
   * is denied by this shell, so the dialog appeared and OK did nothing at all.
   */
  it('sends the link the desktop way instead of leaving it to xterm', async () => {
    activate('https://opentofu.org/docs/cli/commands/plan/')
    await vi.waitFor(() => expect(opened).to.have.length(1))

    expect(opened).to.deep.equal(['https://opentofu.org/docs/cli/commands/plan/'])
  })

  it('says so when the open was refused rather than failing in silence', async () => {
    const reported = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    answer = { ok: true, value: false }

    activate('https://example.test/a')
    await vi.waitFor(() => expect(reported).toHaveBeenCalled())

    expect(reported).toHaveBeenCalledWith('[app-client-ui] terminal link refused: https://example.test/a')
  })

  it('says so when the channel itself failed', async () => {
    const reported = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    answer = { ok: false, error: 'the window is gone' }

    activate('https://example.test/a')
    await vi.waitFor(() => expect(reported).toHaveBeenCalled())

    expect(reported).toHaveBeenCalledWith('[app-client-ui] terminal link: the window is gone')
  })

  /** xterm never hands a non-http link to this handler, and main refuses one if it ever did. */
  it('receives only http links, because the option that would widen it stays off', () => {
    expect(TerminalLinks.handlerConst.allowNonHttpProtocols ?? false).to.equal(false)
  })
})
