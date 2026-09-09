import { useEffect, useState } from 'react'

import type { SessionTranscriptReading } from '../../../../../lib-orchestrator/sessionTranscriptReader/sessionTranscriptReaderApi.types'
import type { SessionOutcome } from '../../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { ErrorText } from '../../../../shared/errorText'
import type { FileChangesViewModel } from '../../../fileViewer/fileViewerPanel.types'

/**
 * What is left of a session once the screen it exited on is gone.
 *
 * While the Host is up it holds the dead runtime and an attach replays the last screen, which is
 * better than anything drawn here. This is for after the Host restarts: the runtimes do not survive
 * it, and until now what was left was an empty panel with an exit code under it. Both of the things
 * that DO survive are read here - the transcript the agent wrote, and what the session changed on
 * disk - and neither is stored by this client: one is the agent's own file and the other is the
 * repository's.
 */
export function TerminalPostMortem(props: {
  sessionId: string
  outcome: SessionOutcome
  endedAt: number | null
  /** The panel's own read, handed down: a second one would be a second list call for one session. */
  changes: FileChangesViewModel
}): React.JSX.Element {
  const { sessionId, outcome, endedAt, changes } = props
  const [transcript, setTranscript] = useState<SessionTranscriptReading | null>(null)

  // Once, on mount: a session that has ended writes nothing more, so there is nothing to poll for.
  // Cleared first, because this block is the one whose whole subject is that somebody else's
  // conversation must never appear here: re-keyed to another session, the previous one's last words
  // would otherwise stand until the new read lands.
  useEffect(() => {
    let live = true
    setTranscript(null)
    void window.appClient.sessionTranscript.get(sessionId)
      .then((answer) => {
        if (!live) return
        setTranscript(answer.ok
          ? answer.value
          : { kind: 'none', code: 'transcript-unreadable', reason: answer.error })
      })
      .catch((thrown: unknown) => {
        if (!live) return
        setTranscript({
          kind: 'none',
          code: 'transcript-unreadable',
          reason: ErrorText.of(thrown),
        })
      })
    return () => { live = false }
  }, [sessionId])

  return (
    <div className="jamat-postmortem">
      <p className="jamat-postmortem__headline">
        <span className={`jamat-postmortem__verdict jamat-postmortem__verdict--${outcome}`}>
          {TerminalPostMortemText.verdictOf(outcome)}
        </span>
        {endedAt !== null && (
          <span className="jamat-postmortem__when">
            {new Date(endedAt).toLocaleString()}
          </span>
        )}
      </p>
      {transcript?.kind === 'messages' && transcript.messages.length > 0 && (
        <>
          <p className="jamat-postmortem__bounds">
            {TerminalPostMortemText.boundsOf(transcript)}
          </p>
          <ol className="jamat-postmortem__messages">
            {transcript.messages.map((message, index) => (
              <li
                className={`jamat-postmortem__message jamat-postmortem__message--${message.role}`}
                key={`${message.at ?? 'no-time'}-${index}`}
              >
                <span className="jamat-postmortem__role">{message.role}</span>
                <span className="jamat-postmortem__text">{message.text}</span>
                {message.textTruncated && (
                  <span className="jamat-postmortem__truncated">Message shortened</span>
                )}
              </li>
            ))}
          </ol>
        </>
      )}
      {/* A block with the verdict and the files is still worth having, so a transcript nobody could
          read says so in one line rather than replacing everything above it with an error. */}
      {transcript?.kind === 'none' && (
        <p className="jamat-postmortem__missing">{`No transcript: ${transcript.reason}`}</p>
      )}
      {changes.snapshot !== null && changes.snapshot.entries.length > 0 && (
        <p className="jamat-postmortem__changes">
          {TerminalPostMortemText.changedOf(changes.snapshot.entries.length)}
        </p>
      )}
    </div>
  )
}

class TerminalPostMortemText {
  static boundsOf(
    reading: Extract<SessionTranscriptReading, { kind: 'messages' }>,
  ): string {
    const scope = reading.earlierContentOmitted ? 'Bounded transcript tail' : 'Transcript messages'
    return `${scope}: up to ${reading.bounds.maxMessages} messages, ${
      reading.bounds.maxCharactersPerMessage} characters each, ${reading.bounds.scannedBytes} bytes scanned`
  }

  static verdictOf(outcome: SessionOutcome): string {
    if (outcome === 'finished') return 'Finished'
    else if (outcome === 'failed') return 'Failed'
    else if (outcome === 'interrupted') return 'Interrupted'
    else
      throw new Error(`Unknown session outcome: ${JSON.stringify(outcome)}`)
  }

  static changedOf(count: number): string {
    return count === 1 ? '1 file changed' : `${count} files changed`
  }
}
