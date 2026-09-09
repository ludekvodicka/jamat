import { JsonNumber } from '../../shared/jsonNumber'
import { JsonShape } from '../../shared/jsonShape'
import { JsonlRecords } from '../../shared/jsonlRecords'
import type { ProviderTranscriptRef } from '../../projectManager/providerTranscriptView'
import { ErrorText } from '../../shared/errorText'
import { FileTail } from '../../shared/fileTail'
import type { SessionModelInfo, SessionModelReading } from '../sessionModelReaderApi.types'
import { SessionModelSource } from '../sessionModelSource'

interface CodexSettings {
  model: string
  effortLevel: string | null
}

export class SessionModelSourceCodex extends SessionModelSource {
  private static readonly tailBytesConst = 524_288
  /**
   * The same ceiling, and the same reason, as `SessionTranscriptSourceCodex` over this very file:
   * this runs on the client's main thread, where the read, the split and one `JSON.parse` per line
   * block the window, the Host socket and every IPC handler for as long as they take. This one is
   * the polled reader of the two, so it is the one that would pay it every tick.
   */
  private static readonly maxReadBytesConst = 4 * 1_048_576
  private static readonly gptModelConst = /^gpt-(\d+(?:\.\d+)*)(?:-(.+))?$/i

  readonly agentId = 'codex' as const

  async read(ref: ProviderTranscriptRef): Promise<SessionModelReading> {
    let info: SessionModelInfo | null
    try {
      info = SessionModelSourceCodex.parse(
        await FileTail.read(ref.file, ref.size, SessionModelSourceCodex.tailBytesConst),
      )
      // A tail can hold a `token_count` whose `turn_context` fell off the front of it, and then the
      // settings that close the pair are only found by reading from the top. Once, with a ceiling.
      if (info === null && ref.size > SessionModelSourceCodex.tailBytesConst)
        info = SessionModelSourceCodex.parse(
          await FileTail.read(ref.file, ref.size, SessionModelSourceCodex.maxReadBytesConst),
        )
    }
    catch (error) {
      return { kind: 'none', reason: `rollout unreadable: ${ErrorText.of(error)}` }
    }
    if (info === null) return { kind: 'none', reason: 'no complete turn_context/token_count pair' }
    return { kind: 'ok', info }
  }

  /**
   * Forward, because Codex writes the settings and their usage as two records: a `turn_context`
   * carries the model and the effort, and the `token_count` that FOLLOWS it carries what that turn
   * cost. Reading it the other way round would pair a count with settings it never ran under.
   *
   * The pair is therefore only closed by a `token_count` that arrives after a `turn_context` was
   * seen, and a newer `turn_context` with no count of its own yet leaves the last complete pair
   * standing rather than half-replacing it.
   */
  private static parse(content: string): SessionModelInfo | null {
    let settings: CodexSettings | null = null
    let complete: SessionModelInfo | null = null
    for (const raw of JsonlRecords.of(content)) {
      const record = JsonShape.record(raw)
      const payload = JsonShape.record(record?.['payload'])
      if (record === null || payload === null) continue
      if (record['type'] === 'turn_context') {
        const model = SessionModelSource.nonEmptyString(payload['model'])
        // A turn_context with no model says nothing; the settings already standing keep standing.
        if (model !== null)
          settings = { model, effortLevel: SessionModelSourceCodex.effortIn(payload) }
        continue
      }
      if (record['type'] !== 'event_msg' || payload['type'] !== 'token_count') continue
      if (settings === null) continue
      const info = JsonShape.record(payload['info'])
      const usage = JsonShape.record(info?.['last_token_usage'])
      const contextTokens = JsonNumber.wholeCount(usage?.['total_tokens'])
      // The count closes the pair on its own. A window Codex did not state travels as null, which
      // the wire carries and the line draws around: V1 threw the whole reading away for it and a
      // new model family silently blanked the widget, model and tokens included.
      if (contextTokens === null) continue
      complete = {
        model: settings.model,
        modelLabel: SessionModelSourceCodex.labelOf(settings.model),
        effortLevel: settings.effortLevel,
        contextTokens,
        contextWindow: JsonNumber.positiveInteger(info?.['model_context_window']),
      }
    }
    return complete
  }

  /** Codex renamed this key twice and kept writing all three shapes; newest name wins. */
  private static effortIn(payload: Record<string, unknown>): string | null {
    const collaborationMode = JsonShape.record(payload['collaboration_mode'])
    const settings = JsonShape.record(collaborationMode?.['settings'])
    for (const value of [payload['effort'], payload['reasoning_effort'], settings?.['reasoning_effort']]) {
      const effort = SessionModelSource.nonEmptyString(value)
      if (effort !== null) return effort
    }
    return null
  }

  /** `gpt-5.1-codex-max` becomes `GPT-5.1 Codex Max`; a slug off the pattern is its own label. */
  private static labelOf(model: string): string {
    const parts = SessionModelSourceCodex.gptModelConst.exec(model)
    if (parts === null) return model
    const suffix = parts[2]
      ?.split('-')
      .filter(Boolean)
      .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
      .join(' ')
    return `GPT-${parts[1]}${suffix ? ` ${suffix}` : ''}`
  }

  /** A window of zero is Codex saying it does not know yet, not a session with no room left. */
}
