import type { SessionHistoryOpenSpec } from '../../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { HistoricSession, HistoricSessionGroup } from '../../../../shared/historicSessions'

export interface HistoricSessionRow extends HistoricSession {
  key: string
  root: HistoricSessionGroup['root']
  project: HistoricSessionGroup['project']
  label: string
  createdLabel: string
  lastUsedLabel: string
  searchText: string
}

export class HistoricSessionsModel {
  static readonly rangesConst = ['1d', '2d', '7d', '1m', 'all'] as const
  static readonly sourcesConst = ['AppJamat', 'All'] as const

  private static readonly dateFormatterConst = new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })

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
        searchText: [root.label, root.path, project.name, project.path, label, session.agentId,
          session.model, session.nativeSessionId, createdLabel, lastUsedLabel].join(' ').toLocaleLowerCase(),
      }
    })
  }

  static sorted(rows: readonly HistoricSessionRow[]): HistoricSessionRow[] {
    return [...rows].sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0)
      || b.createdAt - a.createdAt || a.key.localeCompare(b.key))
  }

  static filtered(rows: readonly HistoricSessionRow[], query: string): HistoricSessionRow[] {
    const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean)
    return rows.filter((row) => words.every((word) => row.searchText.includes(word)))
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
