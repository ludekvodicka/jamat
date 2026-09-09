import { cleanup, render, act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type {
  SessionTranscriptReading,
} from '../../../../../lib-orchestrator/sessionTranscriptReader/sessionTranscriptReaderApi.types'
import type { AppClientUiBridge, IpcResult } from '../../../../shared/appClientUiIpc'
import type { FileChangesViewModel } from '../../../fileViewer/fileViewerPanel.types'
import { TerminalPostMortem } from './terminalPostMortem'

/**
 * The block a panel shows once the Host no longer has the runtime this session died on. Its three
 * guards - the unmount check, the arm for a channel that refused, and the one that keeps an empty
 * list off the screen - were all reachable only through the panel's own tests, which answer every
 * read with `{ ok: true }`, so all three survived being deleted. This file drives the component.
 */
describe('app-client-ui/renderer/panels/terminal/terminalPostMortem', () => {
  let answer: (result: IpcResult<SessionTranscriptReading>) => void
  let pending: Promise<IpcResult<SessionTranscriptReading>>
  let reads: string[]

  const noChangesConst: FileChangesViewModel = {
    snapshot: null,
    groups: [],
    nextCursor: null,
    preferredVcs: null,
    loading: false,
    loadingMore: false,
    error: null,
    reload: () => Promise.resolve(),
    loadMore: () => Promise.resolve(),
  }

  beforeEach(() => {
    reads = []
    answer = () => undefined
    pending = new Promise((resolve) => { answer = resolve })
    const bridge = {
      sessionTranscript: {
        get: (sessionId: string) => {
          reads.push(sessionId)
          return pending
        },
      },
    }
    ;(window as unknown as { appClient: AppClientUiBridge })
      .appClient = bridge as unknown as AppClientUiBridge
  })

  afterEach(() => {
    cleanup()
    delete (window as unknown as { appClient?: unknown }).appClient
  })

  function draw(): ReturnType<typeof render> {
    return render(
      <TerminalPostMortem
        sessionId="session-1"
        outcome="failed"
        endedAt={null}
        changes={noChangesConst}
      />,
    )
  }

  async function settle(): Promise<void> {
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  it('draws the verdict before the transcript has answered', () => {
    const view = draw()

    expect(view.container.querySelector('.jamat-postmortem__verdict')?.textContent).to.equal('Failed')
    expect(reads).to.deep.equal(['session-1'])
  })

  it('says the last words the agent wrote', async () => {
    const view = draw()

    answer({
      ok: true,
      value: {
        kind: 'messages',
        messages: [
          { role: 'user', text: 'run the tests', at: 1, textTruncated: false },
          { role: 'assistant', text: 'two of them failed', at: 2, textTruncated: true },
        ],
        bounds: { maxMessages: 10, maxCharactersPerMessage: 2_000, scannedBytes: 4_096 },
        earlierContentOmitted: true,
      },
    })
    await settle()

    expect([...view.container.querySelectorAll('.jamat-postmortem__text')]
      .map((node) => node.textContent))
      .to.deep.equal(['run the tests', 'two of them failed'])
    expect(view.container.querySelector('.jamat-postmortem__bounds')?.textContent)
      .to.contain('Bounded transcript tail')
    expect(view.container.querySelector('.jamat-postmortem__truncated')?.textContent)
      .to.equal('Message shortened')
  })

  /**
   * A refused channel is not a session with nothing to say. The block keeps its verdict and its file
   * count and adds one line, rather than replacing everything above it with an error.
   */
  it('says in one line why a transcript could not be read, and keeps the rest', async () => {
    const view = draw()

    answer({ ok: false, error: 'the transcript file is gone' })
    await settle()

    expect(view.container.querySelector('.jamat-postmortem__missing')?.textContent)
      .to.equal('No transcript: the transcript file is gone')
    expect(view.container.querySelector('.jamat-postmortem__verdict')?.textContent).to.equal('Failed')
  })

  it('draws no list for a bounded reading that carried no messages', async () => {
    const view = draw()

    answer({
      ok: true,
      value: {
        kind: 'messages',
        messages: [],
        bounds: { maxMessages: 10, maxCharactersPerMessage: 2_000, scannedBytes: 0 },
        earlierContentOmitted: false,
      },
    })
    await settle()

    expect(view.container.querySelector('.jamat-postmortem__messages')).to.equal(null)
    expect(view.container.querySelector('.jamat-postmortem__missing')).to.equal(null)
  })

  /**
   * The read is in flight for as long as a file takes, and the panel can close inside that. What
   * this holds is the outcome - nothing is drawn afterwards. It does NOT hold the `live` guard
   * itself: React 19 makes a setState on an unmounted component a silent no-op, so removing the
   * guard passes this test too. Said out loud rather than counted as coverage it is not.
   */
  it('writes nothing into a block that has gone', async () => {
    const view = draw()
    view.unmount()

    answer({
      ok: true,
      value: {
        kind: 'messages',
        messages: [{ role: 'user', text: 'late', at: 1, textTruncated: false }],
        bounds: { maxMessages: 10, maxCharactersPerMessage: 2_000, scannedBytes: 20 },
        earlierContentOmitted: false,
      },
    })
    await settle()

    expect(document.querySelector('.jamat-postmortem')).to.equal(null)
  })
})
