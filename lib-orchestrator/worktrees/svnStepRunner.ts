import type { WorktreeLease } from './worktreeLease'
import { ErrorText } from '../shared/errorText'
import type { CommandRunOptions, CommandRunner } from '../shared/commandInvoker.types'
import { SvnFailures, type SvnFailureClass } from '../svn/svnFailures'
import type { SessionRecordsStore } from '../sessionManager/worktreeSessionRecords'
import type { SessionScriptsManager } from '../sessionManager/worktreeSessionScripts'
import { WorktreeLifecycleMigration } from './worktreeLifecycleMigration'
import type { SvnStepJournalEntry, SvnStepKind } from './worktreeState'

export type SvnStepIntent = Omit<SvnStepJournalEntry, 'kind' | 'cwd' | 'args' | 'startedAt' | 'endedAt' | 'outcome' | 'runId'>
export type SvnStepResult = { output: string; exitCode: number; runId: string }
  & ({ ok: true } | { ok: false; failure: SvnFailureClass })

export interface SvnStepRunnerDeps {
  lease?: Pick<WorktreeLease, 'within'>
  records: SessionRecordsStore
  scripts: Pick<SessionScriptsManager, 'runLocal' | 'scriptLogOf'>
  svn: CommandRunner
  now: () => number
  newId: () => string
  changed: () => void
}

export class SvnStepRunner {
  private readonly deps: SvnStepRunnerDeps

  constructor(deps: SvnStepRunnerDeps) {
    this.deps = deps
  }

  async run(sessionId: string, kind: SvnStepKind, cwd: string, args: string[], intent: SvnStepIntent,
    options: Pick<CommandRunOptions, 'signal' | 'timeoutMs'> & { beforeRun?: (runId: string) => Promise<void | string>; runId?: string; phase?: 'before' | 'after'; title?: string } = {}): Promise<SvnStepResult> {
    const root = this.leaseRoot(sessionId)
    if (this.deps.lease !== undefined && root !== undefined)
      return this.deps.lease.within(root, kind, () => this.execute(sessionId, kind, cwd, args, intent, options))
    return this.execute(sessionId, kind, cwd, args, intent, options)
  }

  private async execute(sessionId: string, kind: SvnStepKind, cwd: string, args: string[], intent: SvnStepIntent,
    options: Pick<CommandRunOptions, 'signal' | 'timeoutMs'> & { beforeRun?: (runId: string) => Promise<void | string>; runId?: string; phase?: 'before' | 'after'; title?: string }): Promise<SvnStepResult> {
    const lifecycle = this.deps.records.get(sessionId)?.worktreeLifecycle
    const previous = lifecycle?.journal.slice(lifecycle.retryFrom ?? 0) ?? []
    const stopped = SvnStepRunner.repeated(previous)
    if (stopped !== undefined && SvnStepRunner.sameTarget(stopped, { ...intent, kind, cwd }))
      return { ok: false, failure: stopped.outcome as SvnFailureClass, output: SvnStepRunner.diagnosis(stopped), exitCode: 1, runId: stopped.runId }
    const runId = options.runId ?? this.deps.newId()
    let spawned = false
    let refusal: string | undefined
    const result = await this.deps.scripts.runLocal(sessionId, runId, options.title ?? (kind === 'checkout' ? 'Checkout' : `svn ${kind}`), async (output) => {
      try {
        const stopped = await options.beforeRun?.(runId)
        if (stopped !== undefined) {
          output(`${stopped}\n`)
          return { ok: false as const, failure: 'other' as const, output: stopped, exitCode: 1, runId }
        }
      }
      catch (error) { output(`svn ${kind} preparation failed: ${ErrorText.of(error)}\n`); throw error }
      // The command adapter owns the writer marker after its read-only preflight; this runner owns the journal and root lease.
      const outcome = await this.deps.svn.run(cwd, args, { trackClose: true, signal: options.signal, timeoutMs: options.timeoutMs,
        retain: { tailBytes: 1024 * 1024 }, onStdout: output, onStderr: output, onSpawn: () => { spawned = true } }).catch((error: unknown) => {
        output(`svn ${kind} failed: ${ErrorText.of(error)}\n`)
        if (!spawned) refusal = ErrorText.of(error)
        throw error
      })
      const stopped = outcome.failure === null ? '' : `svn ${kind} stopped: ${outcome.failure}`
      if (stopped) output(`\n${stopped}\n`)
      const text = [outcome.stdout, outcome.stderr, stopped].filter(Boolean).join('\n')
      const result: SvnStepResult = outcome.code === 0 && outcome.failure === null
        ? { ok: true, output: text, exitCode: outcome.code, runId }
        : { ok: false, failure: SvnFailures.classify(text, outcome.code), output: text || `svn ${kind}: ${outcome.failure ?? outcome.code}`,
          exitCode: outcome.code, runId }
      if (!text) output(result.output)
      return result
    }, this.deps.changed, { phase: options.phase ?? (kind === 'checkout' ? 'before' : 'after'), scriptId: 'svn', durable: true,
      commands: [`svn ${args.join(' ')}`], recordStart: (record, startedAt) => {
        const state = record.worktreeLifecycle ?? WorktreeLifecycleMigration.fromOld(record)
        if (state === null) throw new Error('An SVN step requires a worktree record')
        return { ...record, worktreeLifecycle: { ...state, version: state.version + 1,
          journal: [...state.journal, { ...intent, kind, cwd, args: [...args], startedAt, runId }] } }
      } }).catch(async (error: unknown) => {
      // svn never started, so nothing is left for recovery to repeat; a commit's intent waits for repository proof.
      if (refusal !== undefined && kind !== 'commit')
        await this.deps.records.update(sessionId, (record) => {
          const state = record.worktreeLifecycle
          if (state === undefined || !state.journal.some((entry) => entry.runId === runId && entry.endedAt === undefined)) return null
          return { ...record, worktreeLifecycle: { ...state, version: state.version + 1, journal: state.journal.map((entry) => entry.runId === runId
            ? { ...entry, endedAt: this.deps.now(), outcome: 'other' as const, output: refusal } : entry) } }
        })
      throw error
    })
    const log = await this.deps.scripts.scriptLogOf(sessionId, runId)
    const completed = await this.deps.records.update(sessionId, (record) => {
      const state = record.worktreeLifecycle
      if (state === undefined || !state.journal.some((entry) => entry.runId === runId)) return null
      const journal = state.journal.map((entry) => entry.runId === runId
        ? { ...entry, endedAt: this.deps.now(), outcome: result.ok ? 'ok' as const : result.failure, output: result.output, logPath: log.ok ? log.value.path : log.detail } : entry)
      const repeated = SvnStepRunner.repeated(journal.slice(state.retryFrom ?? 0))
      return { ...record, worktreeLifecycle: { ...state, version: state.version + 1, journal,
        ...(repeated === undefined ? {} : { stoppedFailure: SvnStepRunner.diagnosis(repeated) }) } }
    })
    if (!completed) throw new Error('The SVN command result journal could not be saved; recovery is required')
    this.deps.changed()
    const latest = this.deps.records.get(sessionId)?.worktreeLifecycle
    const repeated = SvnStepRunner.repeated(latest?.journal.slice(latest.retryFrom ?? 0) ?? [])
    return !result.ok && repeated !== undefined ? { ...result, output: SvnStepRunner.diagnosis(repeated) } : result
  }

  private leaseRoot(sessionId: string): string | undefined {
    const record = this.deps.records.get(sessionId)
    return record?.svnAction?.kind === 'update-main' ? record.svnAction.root : record?.worktree?.worktreePath
  }

  private static sameTarget(left: SvnStepJournalEntry, right: Pick<SvnStepJournalEntry, 'stepId' | 'kind' | 'cwd' | 'paths' | 'targetRevision'>): boolean {
    return left.stepId === right.stepId && left.kind === right.kind && left.cwd === right.cwd
      && left.targetRevision === right.targetRevision && JSON.stringify(left.paths) === JSON.stringify(right.paths)
  }

  private static repeated(journal: readonly SvnStepJournalEntry[]): SvnStepJournalEntry | undefined {
    const last = journal.at(-1)
    const prior = last === undefined ? undefined : journal.slice(0, -1).reverse().find((entry) => SvnStepRunner.sameTarget(entry, last))
    return last !== undefined && prior !== undefined && last.outcome !== undefined && last.outcome !== 'ok'
      && last.outcome !== 'out-of-date' && last.outcome === prior.outcome && SvnStepRunner.sameTarget(prior, last) ? last : undefined
  }

  private static diagnosis(entry: SvnStepJournalEntry): string {
    const reason = entry.outcome === 'auth' ? 'svn sign-in needed' : `svn ${entry.outcome}`
    return `Stopped after two identical failures: ${reason}. Log: ${entry.logPath ?? 'unavailable'}\n${entry.output ?? ''}`
  }
}
