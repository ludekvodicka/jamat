import type { ProviderTranscriptRef } from '../projectManager/providerTranscriptView'
import type { SessionModelAgentId, SessionModelReading } from './sessionModelReaderApi.types'

/**
 * One session as a source is given it: where its transcript is looked up, and what its launch asked
 * it to run on.
 *
 * The launch model is here because the transcript cannot answer it. Claude Code records the bare id
 * the API answered with, `claude-opus-5`, while the `[1m]` tier that decides the context window
 * lives only in the command line the session was started with - which this client wrote itself and
 * kept on the session's own record.
 */
export interface SessionModelContext {
  agentId: SessionModelAgentId
  cwd: string
  nativeSessionId: string
  /** `null` where the launch named no model, and where nothing recorded the one it named. */
  launchModel: string | null
}

/**
 * One provider's way of finding the model, the effort and the context size in its own transcript.
 *
 * A source never throws: a transcript is a file another program is writing right now, so a half
 * record, a shape that changed under us and a session that has said nothing yet are all ordinary
 * endings, and each of them comes back as a `none` carrying its reason.
 */
export abstract class SessionModelSource {
  abstract readonly agentId: SessionModelAgentId

  abstract read(
    ref: ProviderTranscriptRef,
    context: SessionModelContext,
  ): Promise<SessionModelReading>

  /**
   * What this source's reading takes from OUTSIDE the transcript, folded into the reader's cache
   * key. The key is otherwise the transcript's own stat, so a value read from another file would
   * freeze at whatever it was when the transcript last moved - on an ended session, for ever.
   * Empty for a source whose reading comes only from the file it was handed.
   */
  async cacheSaltOf(_context: SessionModelContext): Promise<string> {
    return ''
  }

  protected static nonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null
  }

}
