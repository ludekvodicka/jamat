import type { ProviderTranscriptRef } from '../projectManager/providerTranscriptView'
import { ProviderTranscriptView } from '../projectManager/providerTranscriptView'
import { SessionTranscriptSourceClaude } from './claude/sessionTranscriptSourceClaude'
import { SessionTranscriptSourceCodex } from './codex/sessionTranscriptSourceCodex'
import type {
  SessionTranscriptAgentId,
  SessionTranscriptReading,
} from './sessionTranscriptReaderApi.types'
import { TranscriptTailReader } from '../shared/transcriptTailReader'
import type { SessionTranscriptSource } from './sessionTranscriptSource'

export interface SessionTranscriptResolver {
  resolve(input: {
    agentId: SessionTranscriptAgentId
    cwd: string
    nativeSessionId: string
  }): Promise<ProviderTranscriptRef | null>
}

export interface SessionTranscriptContext {
  agentId: SessionTranscriptAgentId
  cwd: string
  nativeSessionId: string
}

export interface SessionTranscriptReaderDeps {
  transcripts?: SessionTranscriptResolver
  claudeHome?: string
  sources?: readonly SessionTranscriptSource[]
}

/**
 * The tail of what one session said, read straight out of the transcript its agent wrote.
 *
 * The cache, its key and its eviction are `TranscriptTailReader`'s - the model reader beside this one
 * asks a different question off the same file and holds its own. This one has no salt: the file IS
 * the whole input, and the two limits below shape what is made of it rather than what is read.
 */
export class SessionTranscriptReader
  extends TranscriptTailReader<
    SessionTranscriptContext,
    SessionTranscriptReading,
    ProviderTranscriptRef
  > {
  private static readonly maxMessagesConst = 10
  private static readonly maxCharactersPerMessageConst = 2_000

  private readonly sources: ReadonlyMap<SessionTranscriptAgentId, SessionTranscriptSource>

  constructor(deps?: SessionTranscriptReaderDeps) {
    const transcripts = deps?.transcripts
      ?? new ProviderTranscriptView({ claudeHome: deps?.claudeHome })
    super((context) => transcripts.resolve(context))
    const sources = deps?.sources
      ?? [new SessionTranscriptSourceClaude(), new SessionTranscriptSourceCodex()]
    this.sources = new Map(sources.map((source) => [source.agentId, source]))
  }

  read(context: SessionTranscriptContext): Promise<SessionTranscriptReading> {
    return this.readTail(context)
  }

  protected missing(): SessionTranscriptReading {
    return {
      kind: 'none',
      code: 'transcript-not-found',
      reason: 'no transcript for this session',
    }
  }

  /** Nothing outside the file changes what this reads, so the stat alone is the whole key. */
  protected saltOf(): Promise<string> {
    return Promise.resolve('')
  }

  protected cacheable(reading: SessionTranscriptReading): boolean {
    return reading.kind !== 'none' || reading.code !== 'transcript-unreadable'
  }

  protected readFrom(
    ref: ProviderTranscriptRef,
    context: SessionTranscriptContext,
  ): Promise<SessionTranscriptReading> {
    const source = this.sources.get(context.agentId)
    if (!source)
      throw new Error(`No session transcript source for agent: ${JSON.stringify(context.agentId)}`)
    return source.read(ref, {
      maxMessages: SessionTranscriptReader.maxMessagesConst,
      maxCharactersPerMessage: SessionTranscriptReader.maxCharactersPerMessageConst,
    })
  }
}
