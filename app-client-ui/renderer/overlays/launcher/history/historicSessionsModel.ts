import type { SessionHistoryOpenSpec } from '../../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { HistoricSession, HistoricSessionGroup } from '../../../../shared/historicSessions'

export interface HistoricSessionRow extends HistoricSession {
  key: string
  root: HistoricSessionGroup['root']
  project: HistoricSessionGroup['project']
  label: string
  createdLabel: string
  lastUsedLabel: string
  endedLabel: string
  /** The instant the Ended cell points at, null where it names no instant at all. */
  endedInstant: number | null
  endedTitle: string
  /** What Ended sorts on. A running session has not ended, so it sits above every one that has. */
  endedOrder: number
  searchText: string
}

export class HistoricSessionsModel {
  static readonly rangesConst = ['1d', '2d', '7d', '1m', 'all'] as const
  static readonly sourcesConst = ['AppJamat', 'All'] as const

  private static readonly dateFormatterConst = new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
  /** A conversation's own id, wherever it sits in a word: alone, in a file name, or in a path. */
  private static readonly idPatternConst =
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
  /** What a transcript is called on disk, for the words that are a file name rather than an id. */
  private static readonly transcriptSuffixConst = /\.(jsonl|json)$/i

  static lastUsedSince(range: typeof HistoricSessionsModel.rangesConst[number], now = Date.now()): number | null {
    switch (range) {
      case '1d': return now - 86_400_000
      case '2d': return now - 2 * 86_400_000
      case '7d': return now - 7 * 86_400_000
      case '1m': return now - 30 * 86_400_000
      case 'all': return null
      default: throw new Error(`Unknown history range: ${range}`)
    }
  }

  static rows(root: HistoricSessionGroup['root'], project: HistoricSessionGroup['project'], sessions: readonly HistoricSession[]): HistoricSessionRow[] {
    return sessions.map((session) => {
      const label = session.title || session.firstUserMessage || session.nativeSessionId
      const createdLabel = HistoricSessionsModel.dateFormatterConst.format(session.createdAt)
      const lastUsedLabel = session.lastActivity === null ? 'Unknown'
        : HistoricSessionsModel.dateFormatterConst.format(session.lastActivity)
      return {
        ...session,
        key: `${root.id}:${project.name}:${session.agentId}:${session.nativeSessionId}`,
        root, project, label, createdLabel, lastUsedLabel,
        ...HistoricSessionsModel.ending(session),
        // `title` is listed beside `label` although `label` usually IS the title: the label falls
        // back to the first message and then to the id, so a row whose name is hidden behind a
        // fallback would stop being findable by that name the day the fallback order changes.
        searchText: [root.label, root.path, project.name, project.path, label, session.title,
          session.agentId, session.model, session.nativeSessionId, createdLabel,
          lastUsedLabel].join(' ').toLocaleLowerCase(),
      }
    })
  }

  /**
   * The Ended cell, in one place because its three answers have to agree. A recorded ending is the
   * real one; without it the last use is the closest an ending can be guessed at and says so with a
   * `~`; a foreign transcript AppJamat never ran has neither. Nothing here is running: both sources
   * list what ENDED, and a session still running belongs to the sessions tree.
   */
  private static ending(session: HistoricSession): Pick<HistoricSessionRow, 'endedLabel' | 'endedInstant' | 'endedTitle' | 'endedOrder'> {
    if (session.endedAt !== null)
      return { endedLabel: HistoricSessionsModel.dateFormatterConst.format(session.endedAt),
        endedInstant: session.endedAt, endedTitle: 'End recorded by AppJamat', endedOrder: session.endedAt }
    if (session.lastActivity !== null)
      return { endedLabel: `~${HistoricSessionsModel.dateFormatterConst.format(session.lastActivity)}`,
        endedInstant: session.lastActivity, endedTitle: 'No end was recorded; this is the last use',
        endedOrder: session.lastActivity }
    return { endedLabel: 'Unknown', endedInstant: null, endedTitle: 'Neither an end nor a last use was recorded',
      endedOrder: session.createdAt }
  }

  static sorted(rows: readonly HistoricSessionRow[]): HistoricSessionRow[] {
    return [...rows].sort((a, b) => b.endedOrder - a.endedOrder
      || (b.lastActivity ?? 0) - (a.lastActivity ?? 0)
      || b.createdAt - a.createdAt || a.key.localeCompare(b.key))
  }

  static filtered(rows: readonly HistoricSessionRow[], query: string): HistoricSessionRow[] {
    const words = query.trim().split(/\s+/).filter(Boolean)
      .map((word) => HistoricSessionsModel.wordOf(word))
    return rows.filter((row) => words.every((word) => row.searchText.includes(word)))
  }

  /**
   * What one typed word is actually asking for.
   *
   * A row is searched by its conversation id, and the id is what a person HAS: it is the name of
   * the transcript on disk. So a word carrying one is reduced to it, whether it arrived bare, as
   * `<id>.jsonl`, as Codex's `rollout-<timestamp>-<id>.jsonl`, or as a whole path pasted out of a
   * file manager. Without that the suffix alone made the search fail, because the id in the row is
   * the bare one and `<id>.jsonl` is not a substring of it.
   *
   * A word that is a transcript file name without an id keeps its stem for the same reason. Nothing
   * else is touched: a path typed to find a project is still matched against the path.
   */
  static wordOf(word: string): string {
    const id = HistoricSessionsModel.idPatternConst.exec(word)
    if (id !== null) return id[0].toLocaleLowerCase()
    if (!HistoricSessionsModel.transcriptSuffixConst.test(word)) return word.toLocaleLowerCase()
    const leaf = word.split(/[\\/]/).at(-1) ?? word
    return leaf.replace(HistoricSessionsModel.transcriptSuffixConst, '').toLocaleLowerCase()
  }

  static spec(row: HistoricSessionRow, action: NonNullable<SessionHistoryOpenSpec['action']>): SessionHistoryOpenSpec {
    return {
      directory: { mode: 'project', categoryId: row.root.id, projectPath: row.project.path },
      agentId: row.agentId,
      nativeSessionId: row.nativeSessionId,
      providerName: row.label,
      providerActive: row.active,
      action,
    }
  }

}
