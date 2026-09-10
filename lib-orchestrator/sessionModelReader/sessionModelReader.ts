import type { ProviderTranscriptRef } from '../projectManager/providerTranscriptView'
import { ProviderTranscriptView } from '../projectManager/providerTranscriptView'
import { SessionModelSourceClaude } from './claude/sessionModelSourceClaude'
import { SessionModelSourceCodex } from './codex/sessionModelSourceCodex'
import type {
  SessionModelAgentId,
  SessionModelReading,
} from './sessionModelReaderApi.types'
import { TranscriptTailReader } from '../shared/transcriptTailReader'
import type { SessionModelContext, SessionModelSource } from './sessionModelSource'

export interface SessionModelTranscriptResolver {
  resolve(input: {
    agentId: SessionModelAgentId
    cwd: string
    nativeSessionId: string
  }): Promise<ProviderTranscriptRef | null>
}

export interface SessionModelReaderDeps {
  transcripts?: SessionModelTranscriptResolver
  claudeHome?: string
  sources?: readonly SessionModelSource[]
}

/**
 * Model, effort and context size for one session, read straight out of the transcript its agent is
 * writing.
 *
 * The cache, its key and its eviction are `TranscriptTailReader`'s - the reader beside this one asks
 * a different question off the same file and holds its own. What is this class's own is the salt:
 * Claude's effort lives in settings files the transcript knows nothing about, so without it an ended
 * session would draw the effort it had at its last turn until the window was restarted.
 */
export class SessionModelReader
  extends TranscriptTailReader<SessionModelContext, SessionModelReading, ProviderTranscriptRef> {
  private readonly sources: ReadonlyMap<SessionModelAgentId, SessionModelSource>

  constructor(deps?: SessionModelReaderDeps) {
    const transcripts = deps?.transcripts
      ?? new ProviderTranscriptView({ claudeHome: deps?.claudeHome })
    super((context) => transcripts.resolve(context))
    const sources = deps?.sources
      ?? [new SessionModelSourceClaude(deps?.claudeHome), new SessionModelSourceCodex()]
    this.sources = new Map(sources.map((source) => [source.agentId, source]))
  }

  /*
   * The source is looked up BEFORE the transcript is resolved, and that ordering is deliberate: an
   * agent this reader has no source for is a defect in the wiring, and it must say so whether or not
   * a file happens to be there to read.
   */
  async read(context: SessionModelContext): Promise<SessionModelReading> {
    this.sourceOf(context.agentId)
    return this.readTail(context)
  }

  protected missing(): SessionModelReading {
    return { kind: 'none', reason: 'no transcript for this session' }
  }

  protected saltOf(context: SessionModelContext): Promise<string> {
    return this.sourceOf(context.agentId).cacheSaltOf(context)
  }

  protected readFrom(
    ref: ProviderTranscriptRef,
    context: SessionModelContext,
  ): Promise<SessionModelReading> {
    return this.sourceOf(context.agentId).read(ref, context)
  }

  private sourceOf(agentId: SessionModelAgentId): SessionModelSource {
    const source = this.sources.get(agentId)
    if (!source)
      throw new Error(`No session model source for agent: ${JSON.stringify(agentId)}`)
    return source
  }
}
