import { realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { PerfReportView } from '../../perfMonitor/perfReportView'
import type { PerfBuild } from '../../perfMonitor/perfRecord.types'
import { ErrorText } from '../../shared/errorText'
import { PathCompare } from '../../shared/pathCompare'
import type { SnapinKindValues } from '../snapinsApi.types'
import type { AttemptRecord, LaunchSpec, SnapinContext, SnapinDefinition, SnapinItem } from '../shared/snapinContract'
import { WorktreeEnding } from '../shared/worktreeEnding'
import { PerfStallsBrief } from './perfStallsBrief'

export class PerfStallsSnapin implements SnapinDefinition {
  readonly kind: string
  readonly title: string
  readonly colour: SnapinDefinition['colour']
  readonly menuOrder: number
  readonly settings: SnapinDefinition['settings']
  private readonly source: { directories: readonly string[]; clientBuild: PerfBuild;
    hostProcess: () => { pid: number; startedAt: number } | null } | undefined

  constructor(source?: PerfStallsSnapin['source']) {
    this.source = source
    this.kind = 'perfStalls'
    this.title = 'Perf stalls'
    this.colour = 'amber'
    this.menuOrder = 30
    this.settings = {
      fields: async values => [
        { kind: 'text', id: 'targetProjectDirectory', label: 'Target project directory', value: this.target(values) },
        { kind: 'number', id: 'selfMsPerActiveHour', label: 'Self blocking ms per active hour',
          value: this.threshold(values, 'selfMsPerActiveHour', 1_000), min: 0, max: 1_000_000_000 },
        { kind: 'number', id: 'maxSpanMs', label: 'Single span ms', value: this.threshold(values, 'maxSpanMs', 2_000), min: 0, max: 1_000_000_000 },
      ],
      validate: values => {
        if (values.targetProjectDirectory !== undefined && (typeof values.targetProjectDirectory !== 'string'
          || values.targetProjectDirectory.trim() !== '' && !isAbsolute(values.targetProjectDirectory.trim())))
          return 'Target project directory must be an absolute path or empty'
        for (const name of ['selfMsPerActiveHour', 'maxSpanMs']) {
          const value = values[name]
          if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000_000))
            return 'Performance thresholds must be numbers between 0 and 1000000000'
        }
        return null
      },
    }
  }

  async list(ctx: SnapinContext, values: SnapinKindValues): ReturnType<SnapinDefinition['list']> {
    if (!this.source) return { ok: false, detail: 'Performance record source is unavailable' }
    const invalid = this.settings.validate(values)
    if (invalid) return { ok: false, detail: invalid }
    try {
      const build = this.source.clientBuild
      const until = ctx.now()
      const clusters = await PerfReportView.clusters(this.source.directories, {
        since: until - 7 * 86_400_000, until, hostProcess: this.source.hostProcess(),
        runningBuilds: { main: build, renderer: build, gateway: build, orchestrator: build,
          'worker:tokenUsage': build, 'worker:fileDiff': build, 'worker:svnAssembly': build },
        selfMsPerActiveHour: this.threshold(values, 'selfMsPerActiveHour', 1_000), maxSpanMs: this.threshold(values, 'maxSpanMs', 2_000),
      })
      const target = this.target(values)
      const hold = this.hold(ctx, target)
      return { ok: true, items: clusters.map(row => ({ key: `${row.process}:${row.name}:${row.build.inputHash}`,
        title: `${row.process} / ${row.name}: ${row.selfMsPerActiveHour === null ? 'rate unavailable' : Math.round(row.selfMsPerActiveHour) + ' ms/h'}, max ${Math.round(row.maxMs)} ms`,
        group: target || 'Performance', mode: 'wt', projectDirectory: target, ...(hold ? { hold } : {}), selectable: !hold, actions: [],
        payload: { process: row.process, name: row.name, version: row.build.version, inputHash: row.build.inputHash, builtAt: row.build.builtAt,
          selfMs: row.selfMs, count: row.count, maxMs: row.maxMs, activeHours: row.activeHours,
          selfMsPerActiveHour: row.selfMsPerActiveHour ?? 'unavailable', profileId: row.profileId ?? '' } })) }
    } catch (error) { return { ok: false, detail: ErrorText.of(error) } }
  }

  async launchSpec(ctx: SnapinContext, values: SnapinKindValues, item: SnapinItem, attemptId: string): Promise<LaunchSpec | { hold: string }> {
    const invalid = this.settings.validate(values)
    if (invalid) return { hold: invalid }
    const target = this.target(values)
    const hold = this.hold(ctx, target)
    if (hold) return { hold }
    let resolvedTarget: string
    try { resolvedTarget = await realpath(target) }
    catch (error) { return { hold: ErrorText.of(error) } }
    if (PathCompare.comparable(resolvedTarget) !== PathCompare.comparable(item.projectDirectory))
      return { hold: 'Target changed; refresh the performance listing' }
    const url = await ctx.svn.urlOf(target)
    if (!url.ok) return { hold: url.detail }
    return { directory: { mode: 'adHoc', path: target }, title: `Perf ${item.payload.process}: ${item.payload.name}`,
      promptTemplate: PerfStallsBrief.prompt(),
      number: `p${parseInt(attemptId.replace(/-/g, '').slice(0, 5), 16) % 1_000_000}`, worktreeSlug: attemptId.slice(0, 8), work: PerfStallsBrief.of(item) }
  }

  async evidence(ctx: SnapinContext, attempt: AttemptRecord): ReturnType<SnapinDefinition['evidence']> {
    const session = ctx.sessions.snapshot().sessions.find(row => row.sessionId === attempt.sessionId || row.callerOperationId === attempt.attemptId)
    if (session?.worktree?.kind === 'git' || WorktreeEnding.of(session) === 'open') return { published: false }
    const results = await ctx.sessions.worktreeResults({ tag: attempt.attemptId })
    if (!results.ok) return { published: false }
    const own = results.value.results.filter(row => row.tag === attempt.attemptId)
    if (own.some(row => row.result === 'committed')) return { published: true, detail: 'Performance worktree landed' }
    if (own.some(row => row.result === 'discarded' || row.result === 'nothing' || row.result === 'never-started')) return { discarded: true }
    return { published: false }
  }

  solveAllOrder(items: SnapinItem[]): SnapinItem[] {
    return [...items].sort((a, b) => Number(b.payload.selfMs) - Number(a.payload.selfMs) || a.key.localeCompare(b.key))
  }

  async press(): ReturnType<SnapinDefinition['press']> { return { ok: false, code: 'unknown-action' } }

  private target(values: SnapinKindValues): string { return typeof values.targetProjectDirectory === 'string' ? values.targetProjectDirectory.trim() : '' }
  private threshold(values: SnapinKindValues, name: string, fallback: number): number { return typeof values[name] === 'number' ? values[name] : fallback }
  private hold(ctx: SnapinContext, target: string): string | null {
    if (!target) return 'Set the target project directory in Settings > Snap-ins'
    const mode = ctx.sessions.versioningMode()
    if (mode === 'checkpoints') return null
    else if (mode === 'git') return 'Perf stalls requires an SVN worktree target'
    else throw new Error(`Unknown versioning mode ${mode satisfies never}`)
  }
}
