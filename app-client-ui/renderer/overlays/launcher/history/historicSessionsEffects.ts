import type { CategoryInfo, ProjectEntry } from '../../../../../lib-orchestrator/projectManager/projectManagerApi.types'
import type { SessionHistoryOpenSpec } from '../../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { TerminalTarget } from '../../../../shared/terminalTarget'
import { ErrorText } from '../../../../shared/errorText'
import { AppClientUiReport } from '../../../../shared/appClientUiReport'
import type { PanelOpenOutcome } from '../../../shell/appShell.types'
import { SessionTabOpener } from '../../../shell/sessionTabOpener'
import { HistoricSessionsModel, type HistoricSessionRow } from './historicSessionsModel'

export class HistoricSessionsEffects {
  private started: { sessionId: string; tabTitle: string } | null = null

  hasStarted(): boolean { return this.started !== null }

  static async load(
    source: typeof HistoricSessionsModel.sourcesConst[number],
    lastUsedSince: number | null,
    active: () => boolean,
    report: (detail: string) => void,
    progress: (completed: number, total: number) => void,
  ): Promise<HistoricSessionRow[]> {
    if (source === 'AppJamat') {
      const answer = await window.appClient.historicSessions.appJamat(lastUsedSince)
      if (!active()) return []
      if (!answer.ok) throw new Error(answer.error)
      return HistoricSessionsModel.sorted(answer.value.flatMap((group) => HistoricSessionsModel.rows(group.root, group.project, group.sessions)))
    } else if (source === 'All') return this.loadAll(lastUsedSince, active, report, progress)
    else throw new Error(`Unknown history source: ${source}`)
  }

  private static async loadAll(
    lastUsedSince: number | null,
    active: () => boolean,
    report: (detail: string) => void,
    progress: (completed: number, total: number) => void,
  ): Promise<HistoricSessionRow[]> {
    const categories = await window.appClient.projects.categories()
    if (!active()) return []
    if (!categories.ok) throw new Error(categories.error)
    const jobs: { root: CategoryInfo; project: ProjectEntry }[] = []
    const seen = new Set<string>()
    for (const root of categories.value) {
      if (!active()) return []
      if (!root.available) {
        report(`${root.label}: root is unavailable (${root.path}).`)
        continue
      }
      const listed = await window.appClient.projects.list(root.id, 'alpha')
      if (!active()) return []
      if (!listed.ok) { report(`${root.label}: ${listed.error}`); continue }
      if (!listed.value.ok) { report(`${root.label}: ${listed.value.detail}`); continue }
      if (!listed.value.value.available) report(`${root.label}: root is unavailable.`)
      if (listed.value.value.truncated) report(`${root.label}: project listing is incomplete.`)
      for (const project of listed.value.value.projects) {
        if (seen.has(project.path)) continue
        seen.add(project.path)
        jobs.push({ root, project })
      }
    }
    let next = 0
    let completed = 0
    const rows: HistoricSessionRow[] = []
    progress(completed, jobs.length)
    await Promise.all(Array.from({ length: 3 }, async () => {
      while (active()) {
        const job = jobs[next++]
        if (!job) return
        try {
          const answer = await window.appClient.historicSessions.project(job.root.id, job.project.name, lastUsedSince)
          if (!active()) return
          if (!answer.ok) report(`${job.project.name}: ${answer.error}`)
          else if (!answer.value.ok) report(`${job.project.name}: ${answer.value.detail}`)
          else rows.push(...HistoricSessionsModel.rows(job.root, job.project, answer.value.value))
        } catch (error) {
          if (active()) report(`${job.project.name}: ${ErrorText.of(error)}`)
        } finally {
          if (active()) progress(++completed, jobs.length)
        }
      }
    }))
    return active() ? HistoricSessionsModel.sorted(rows) : []
  }

  async open(
    spec: SessionHistoryOpenSpec,
    openTerminal: (target: TerminalTarget, title: string) => Promise<PanelOpenOutcome>,
  ): Promise<void> {
    if (this.started === null) {
      const answer = await window.appClient.sessions.openHistory(spec)
      if (!answer.ok) throw new Error(answer.error)
      if (!answer.value.ok) throw new Error(answer.value.detail)
      this.started = answer.value.value
    }
    const { sessionId, tabTitle } = this.started
    const published = await window.appClient.tabs.publishTerminalRestarted(sessionId)
    if (!published.ok) AppClientUiReport.error(`terminal restart not published: ${published.error}`)
    const failure = await SessionTabOpener.open(
      (id, title) => openTerminal({ kind: 'local', sessionId: id }, title),
      sessionId, tabTitle,
    )
    if (failure !== null) throw new Error(failure)
  }
}
