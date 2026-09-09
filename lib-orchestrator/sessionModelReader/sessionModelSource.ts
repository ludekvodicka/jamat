import type { ProviderTranscriptRef } from '../projectManager/providerTranscriptView'
import type { SessionModelAgentId, SessionModelReading } from './sessionModelReaderApi.types'

/**
 * One provider's way of finding the model, the effort and the context size in its own transcript.
 *
 * A source never throws: a transcript is a file another program is writing right now, so a half
 * record, a shape that changed under us and a session that has said nothing yet are all ordinary
 * endings, and each of them comes back as a `none` carrying its reason.
 */
export abstract class SessionModelSource {
  abstract readonly agentId: SessionModelAgentId

  abstract read(ref: ProviderTranscriptRef, cwd: string): Promise<SessionModelReading>

  /**
   * What this source's reading takes from OUTSIDE the transcript, folded into the reader's cache
   * key. The key is otherwise the transcript's own stat, so a value read from another file would
   * freeze at whatever it was when the transcript last moved - on an ended session, for ever.
   * Empty for a source whose reading comes only from the file it was handed.
   */
  async cacheSaltOf(_cwd: string): Promise<string> {
    return ''
  }

  protected static nonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null
  }

}
