import { JsonNumber } from '../../shared/jsonNumber'
import { JsonShape } from '../../shared/jsonShape'
import { JsonlRecords } from '../../shared/jsonlRecords'
import type { ProviderTranscriptRef } from '../../projectManager/providerTranscriptView'
import { ClaudeConfigHome } from '../../shared/claudeConfigHome'
import { ErrorText } from '../../shared/errorText'
import { FileTail } from '../../shared/fileTail'
import type { SessionModelReading } from '../sessionModelReaderApi.types'
import { type SessionModelContext, SessionModelSource } from '../sessionModelSource'
import { ClaudeContextWindows } from './claudeContextWindows'
import { ClaudeSettingsCascade } from './claudeSettingsCascade'

interface ClaudeTurn {
  model: string
  tokens: number
}

export class SessionModelSourceClaude extends SessionModelSource {
  private static readonly firstPassBytesConst = 262_144
  private static readonly secondPassBytesConst = 1_048_576
  /**
   * Claude Code writes a `model:"<synthetic>"` assistant turn for local-only interactions - a fresh
   * session before its first API turn, `/context`, `/compact`, an interrupted turn. It carries no
   * real model and usually no usage, so taking it would name the model `<synthetic>` and, against a
   * guessed window, inflate the context percentage several times over.
   */
  private static readonly realModelConst = /^claude-/i

  readonly agentId = 'claude' as const

  private readonly claudeHome: string

  constructor(claudeHome?: string) {
    super()
    this.claudeHome = ClaudeConfigHome.resolve(claudeHome)
  }

  /**
   * The effort AND the context window come from outside the transcript the key is taken from - three
   * settings files and the model this session was launched with - so both would otherwise freeze at
   * what they were when the transcript last moved.
   */
  override async cacheSaltOf(context: SessionModelContext): Promise<string> {
    return JSON.stringify([
      context.launchModel,
      await ClaudeSettingsCascade.readingOf(context.cwd, this.claudeHome),
    ])
  }

  async read(
    ref: ProviderTranscriptRef,
    context: SessionModelContext,
  ): Promise<SessionModelReading> {
    let turn: ClaudeTurn | null
    try {
      turn = SessionModelSourceClaude.scan(
        await FileTail.read(ref.file, ref.size, SessionModelSourceClaude.firstPassBytesConst),
      )
      if (turn === null && ref.size > SessionModelSourceClaude.firstPassBytesConst)
        turn = SessionModelSourceClaude.scan(
          await FileTail.read(ref.file, ref.size, SessionModelSourceClaude.secondPassBytesConst),
        )
    }
    catch (error) {
      return { kind: 'none', reason: `transcript unreadable: ${ErrorText.of(error)}` }
    }
    if (turn === null) return { kind: 'none', reason: 'no real assistant turn in the transcript tail' }
    const settings = await ClaudeSettingsCascade.readingOf(context.cwd, this.claudeHome)
    return { kind: 'ok', info: {
      model: turn.model,
      modelLabel: ClaudeContextWindows.labelOf(turn.model),
      effortLevel: settings.effortLevel,
      contextTokens: turn.tokens,
      // The launch WINS over the settings files rather than falling through to them: `--model` is
      // what the agent was actually started with, so a launch that named a model without a tier is
      // evidence that the settings file's tier is not what this session runs on. It is also the only
      // source there is on a machine that configures the model in this app instead of in Claude's
      // own settings, which is where a million-token session was drawn as a fifth of itself.
      contextWindow: ClaudeContextWindows.windowOf(
        turn.model, context.launchModel ?? settings.model),
    } }
  }

  /**
   * Backward, because the answer is the LAST real assistant turn and assistant turns are frequent
   * enough that it is all but always within the first window.
   *
   * A `compact_boundary` newer than that turn wins the token count: the turn just before a compact is
   * the near-full one that provoked it, so reading it would hold the old count on screen until the
   * next real turn is written. Going backward, a real turn met FIRST is newer than any boundary and
   * its own usage stands - which is why the boundary is only ever taken before one is found.
   */
  private static scan(content: string): ClaudeTurn | null {
    const records = JsonlRecords.of(content)
    let postCompactTokens: number | null = null
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = JsonShape.record(records[index])
      if (record === null) continue
      if (postCompactTokens === null && record['subtype'] === 'compact_boundary') {
        const metadata = JsonShape.record(record['compactMetadata'])
        postCompactTokens = JsonNumber.wholeCount(metadata?.['postTokens'])
        continue
      }
      if (record['type'] !== 'assistant') continue
      const message = JsonShape.record(record['message'])
      const model = SessionModelSource.nonEmptyString(message?.['model'])
      const usage = JsonShape.record(message?.['usage'])
      if (model === null || usage === null) continue
      if (!SessionModelSourceClaude.realModelConst.test(model)) continue
      return { model, tokens: postCompactTokens ?? SessionModelSourceClaude.tokensIn(usage) }
    }
    return null
  }

  /** What the next turn will be handed back: the fresh input plus everything read out of cache. */
  private static tokensIn(usage: Record<string, unknown>): number {
    return (JsonNumber.wholeCount(usage['input_tokens']) ?? 0)
      + (JsonNumber.wholeCount(usage['cache_read_input_tokens']) ?? 0)
      + (JsonNumber.wholeCount(usage['cache_creation_input_tokens']) ?? 0)
  }
}
