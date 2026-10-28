export type { WorkerHandoff } from '../../worktrees/worktreeContracts'
import { randomUUID } from 'node:crypto'
import type { SessionRecord } from '../records/sessionRecord.types'
import type { SessionRecordsStore } from '../records/sessionRecordsStore'
import type { NotifySource, PendingNotify } from './sessionNotifier'
import { SvnConflictShapes } from '../../svn/svnConflictShapes'
import { ErrorText } from '../../shared/errorText'

export class WorkerHandoffs implements NotifySource {
  /**
   * Every Jamat CLI command a handoff asks the worker to run, as the words its line starts with. The
   * worker's launch allows exactly these lines, so a handoff names no other command (UA1-J14R-2).
   */
  private static readonly commandsConst = {
    worktree: ['sessions', 'worktree', '--self'],
    conflicts: ['sessions', 'conflicts', '--self'],
    settle: ['sessions', 'resolve-conflict', '--self'],
    propose: ['commit', 'propose', '--self', '--message-file'],
  } as const satisfies Record<string, readonly string[]>

  private readonly records: () => Pick<SessionRecordsStore, 'list' | 'get' | 'update'> | null
  /**
   * The exact line the worker runs one Jamat CLI command with (`lineOf`), in its own shell and with
   * its own `--self`. A brief that only names a command leaves a worker that cannot find it (UA1-J14-3).
   */
  private readonly cli: (record: SessionRecord, args: readonly string[]) => string

  constructor(records: WorkerHandoffs['records'], cli: WorkerHandoffs['cli']) {
    this.records = records
    this.cli = cli
  }

  async enqueue(sessionId: string, key: string, text: string): Promise<void> {
    const records = this.records()
    if (records === null) throw new Error('Worker records are unavailable')
    if (records.get(sessionId)?.worktreeLifecycle?.handoff?.key === key) return
    if (!await records.update(sessionId, (record) => {
      const state = record.worktreeLifecycle
      if (state === undefined) return null
      if (state.handoff?.key === key) return record
      return { ...record, worktreeLifecycle: { ...state, handoff: { id: randomUUID(), key, text, at: Date.now(), attempts: 0, state: 'pending' } } }
    })) throw new Error('The worker handoff could not be saved')
  }

  async conflicts(sessionId: string): Promise<void> {
    const record = this.records()?.get(sessionId)
    const state = record?.worktreeLifecycle
    const entries = state?.syncConflictSet?.entries.filter((entry) => entry.state !== 'settled') ?? []
    if (record == null || state?.step !== 'worker-resolving' || entries.length === 0) return
    await this.enqueue(sessionId, `conflicts:${state.actionId}:${state.syncConflictSet!.readAt}`, this.conflictBrief(record))
  }

  /** The first line stays a sentence: the idle gate quotes it as the reason the worker is not idle. */
  async checksFailed(sessionId: string, at: number, logPath: string): Promise<void> {
    const record = this.records()?.get(sessionId)
    if (record == null) return
    await this.enqueue(sessionId, `checks:${at}`, [
      'Checks failed. Repair the worktree, then propose it again.',
      `Full retained log: ${logPath}`,
      `Propose it again with: ${this.lineOrWords(record, WorkerHandoffs.commandsConst.propose)} MESSAGE_FILE`,
      'MESSAGE_FILE is a file that holds your commit message.',
    ].join('\n'))
  }

  async redeliver(sessionId: string): Promise<void> {
    const records = this.records()
    const record = records?.get(sessionId)
    if (record == null) return
    const resume = `resume:${record.worktreeLifecycle?.actionId}`
    const handoff = record.worktreeLifecycle?.handoff
    // The resume of an earlier action says nothing about this one, so this one gets its own.
    if (handoff === undefined || handoff.key.startsWith('resume:') && handoff.key !== resume) {
      await this.enqueue(sessionId, resume, ['Continue the interrupted worktree task in this conversation.',
        `Read its current step with: ${this.lineOrWords(record, WorkerHandoffs.commandsConst.worktree)}`].join('\n'))
      return
    }
    await records!.update(sessionId, (latest) => {
      const state = latest.worktreeLifecycle
      const handoff = state?.handoff
      if (state === undefined || handoff === undefined || !WorkerHandoffs.applies(latest)) return null
      return { ...latest, worktreeLifecycle: { ...state, handoff: { ...handoff, id: randomUUID(), state: 'pending', attempts: 0, settledAt: undefined } } }
    })
  }

  async notifyCaller(sessionId: string, text: string): Promise<void> {
    const records = this.records()
    if (records?.get(sessionId)?.worktree?.caller?.notify === undefined) return
    if (!await records.update(sessionId, (record) => record.worktreeLifecycle === undefined ? null : {
      ...record, worktreeLifecycle: { ...record.worktreeLifecycle,
        workerNotice: { id: randomUUID(), key: 'worker-liveness', text, at: Date.now(), attempts: 0, state: 'pending' } },
    })) throw new Error('The worker caller notice could not be saved')
  }

  private static applies(record: SessionRecord): boolean {
    const state = record.worktreeLifecycle
    const handoff = state?.handoff
    if (handoff?.key.startsWith('conflicts:')) return state?.step === 'worker-resolving'
      && handoff.key.startsWith(`conflicts:${state.actionId}:`)
      && state.syncConflictSet?.entries.some((entry) => entry.state !== 'settled') === true
    if (handoff?.key.startsWith('checks:')) return state?.phase === 'active' && state.checks?.passed === false
      && !state.checks.overridden && handoff.key === `checks:${state.checks.at}`
    // A resume left from an earlier action would hold every later Finish at its idle gate (UA1-J13-1).
    if (handoff?.key.startsWith('resume:') && handoff.key !== `resume:${state?.actionId}`) return false
    return state?.phase === 'active' || state?.phase === 'finishing' || state?.phase === 'waiting'
  }

  private conflictBrief(record: SessionRecord): string {
    const state = record.worktreeLifecycle
    const set = state?.syncConflictSet
    const entries = set?.entries.filter((entry) => entry.state !== 'settled') ?? []
    const listing = this.cli(record, WorkerHandoffs.commandsConst.conflicts)
    return [
      `${entries.length + (set?.more ?? 0)} conflicts wait for the worker in ${record.worktree?.worktreePath}.`,
      'Preserve both sides, edit the working files, then settle each path using the Jamat CLI. Do not run svn writes.',
      ...entries.flatMap((entry) => {
        const saved = entry.saved ?? state?.conflictMemory?.paths.find((path) => path.path === entry.path)?.saved
        return [`Path: ${JSON.stringify(entry.path)}; saved copies: ${saved ?? `see ${listing}`}`,
          ...entry.options.filter((option) => SvnConflictShapes.agentOption(entry.shape, entry.kind, option, entry.facts.properties)).map((option) =>
            this.cli(record, WorkerHandoffs.settlementArgsOf(entry.path, option,
              set?.entries.some((other) => other !== entry && other.path === entry.path) ? entry.kind : undefined)))]
      }),
      ...(set?.more ? [`The retained list is incomplete; read it before proceeding: ${listing}`] : []),
    ].join('\n')
  }

  /** The runnable line, or its words and why this client cannot name its CLI: a resume or a check verdict must still reach the worker. */
  private lineOrWords(record: SessionRecord, args: readonly string[]): string {
    try { return this.cli(record, args) }
    catch (error) { return `jamat-v3 ${args.join(' ')} (this client could not name its Jamat CLI: ${ErrorText.of(error)})` }
  }

  /** `kind` only where the path holds another conflict (a text and a property conflict on one file). */
  static settlementArgsOf(path: string, option: string, kind?: string): string[] {
    return [...WorkerHandoffs.commandsConst.settle, '--path', path, ...kind === undefined ? [] : ['--kind', kind], '--option', option]
  }

  /** The line each handoff command starts with, written by `line` as the handoffs write it: what the worker's launch allows. */
  static linesOf(line: (args: readonly string[]) => string): string[] {
    return Object.values(WorkerHandoffs.commandsConst).map((args) => line(args))
  }

  /** The handoff line of this worker over the resolved `jamat-cli` tool: PowerShell for Codex on Windows, else a POSIX shell. */
  static lineFor(tool: { command: string; prefixArgs: readonly string[]; env: Readonly<Record<string, string>> },
    record: Pick<SessionRecord, 'agent'>, args: readonly string[], platform: NodeJS.Platform = process.platform): string {
    return WorkerHandoffs.lineOf(tool.command, tool.prefixArgs, args, record.agent?.agentId === 'codex' && platform === 'win32' ? 'powershell' : 'posix', tool.env)
  }

  /** One CLI command line, every word quoted for the worker's shell, its environment in front. */
  static lineOf(command: string, prefix: readonly string[], args: readonly string[], shell: 'powershell' | 'posix', env: Readonly<Record<string, string>> = {}): string {
    const powershell = shell === 'powershell'
    const quote = (value: string): string => powershell ? `'${value.replace(/'/g, "''")}'` : `'${value.replace(/'/g, `'\\''`)}'`
    const environment = Object.entries(env).map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('Invalid CLI environment name')
      return powershell ? `$env:${key}=${quote(value)}; ` : `${key}=${quote(value)} `
    }).join('')
    return `${environment}${powershell ? '& ' : ''}${[command, ...prefix, ...args].map(quote).join(' ')}`
  }

  pending(): PendingNotify[] {
    return (this.records()?.list() ?? []).flatMap((record) => {
      const handoff = record.worktreeLifecycle?.handoff
      const caller = record.worktree?.caller?.notify
      const notice = record.worktreeLifecycle?.workerNotice
      return [...handoff?.state === 'pending' && WorkerHandoffs.applies(record) ? [{ ...handoff, sessionId: record.sessionId }] : [],
        ...notice?.state === 'pending' && caller !== undefined ? [{ ...notice, sessionId: caller.sessionId, text: caller.text }] : []]
    })
  }

  async note(ids: readonly string[], state: 'delivered' | 'attempted' | 'expired', at: number): Promise<void> {
    const records = this.records()
    if (records === null) return
    for (const record of records.list()) {
      for (const field of ['handoff', 'workerNotice'] as const) {
        const id = record.worktreeLifecycle?.[field]?.id
        if (id === undefined || !ids.includes(id)) continue
        await records.update(record.sessionId, (latest) => {
          const lifecycle = latest.worktreeLifecycle
          const handoff = lifecycle?.[field]
          if (lifecycle === undefined || handoff?.id !== id || handoff.state !== 'pending') return null
          if (state === 'attempted') return { ...latest, worktreeLifecycle: { ...lifecycle, [field]: { ...handoff, attempts: handoff.attempts + 1 } } }
          else if (state === 'delivered' || state === 'expired') return { ...latest, worktreeLifecycle: { ...lifecycle, [field]: { ...handoff, state, settledAt: at } } }
          else throw new Error(`Unknown handoff state: ${JSON.stringify(state satisfies never)}`)
        })
      }
    }
  }
}
