import { basename } from 'node:path'

import type { SvnConflictKind, SvnConflictOption, SvnLogEntry } from '../../svn/svn.types'
import { SvnConflictShapes } from '../../svn/svnConflictShapes'
import type { SessionRecord, SvnActionConflictEntry, SvnActionConflictSet } from '../../sessionManager/worktreeSessionRecords'
import { SessionScriptDefinitions } from '../../sessionManager/worktreeSessionScripts'
import type { SessionCreateSpec } from '../../sessionManager/sessionManagerApi.types'
import type { SessionInternalMarks } from '../worktreeLifecycle.types'
import { SvnConflictWords } from './svnConflictWords'
import { SvnResolverLauncher } from './svnResolverLauncher'

/** What a brief is written from: the session, its working copy, the set, the other commits and the CLI line. */
export interface SvnMergerBriefInput {
  title: string
  root: string
  set: SvnActionConflictSet
  /** The commits the update brought, oldest first. */
  log: readonly SvnLogEntry[]
  /** The command line of this client's Jamat CLI, `RunTools.agentCli`. */
  cli: string
}

/**
 * The interactive Claude merger of an SVN Finish: what it is started as and what it is told. It runs
 * in the worktree, decides each path the rules left and settles it with one
 * `jamat-v3 sessions resolve-conflict --self` call; Jamat runs every svn write. It forks the worker's
 * Claude conversation by the resolver's rule, so it knows why each change was made.
 */
export class SvnMergerLauncher {
  static readonly idleLimitMilliseconds = 20 * 60_000

  /**
   * The longest gap between two looks of this client process that still continues the worker's idle
   * stretch. A hidden window looks every 15 s and a slow session queue later; a 10 s bound never let
   * the worker's time reach the merger while the window was hidden. A longer gap, or the first look of
   * a new client process (`lastLookAt` undefined), starts a new stretch.
   */
  static readonly lookGapMilliseconds = 60_000
  /** A merger whose Claude has not confirmed its conversation by then is held, by a startup dialog for example (008). */
  static readonly startLimitMilliseconds = 5 * 60_000

  /**
   * Who works on the open conflicts and for how long, read from time stamps: `observedAt` starts the
   * current stretch and `milliseconds` holds the time before it. The worker counts idle time only, the
   * merger wall time since its start or its last settlement. `changed` is false while nothing but the
   * clock moved, so a drive writes the record only on a change (a write each poll rewrote the records
   * file every 2 s).
   */
  static fallback(state: import('../worktreeState').WorktreeLifecycle, idle: boolean, at: number, lastLookAt?: number): {
    action: 'wait' | 'merger' | 'person'; progress: NonNullable<import('../worktreeState').WorktreeLifecycle['conflictProgress']>; changed: boolean
  } {
    const settled = state.syncConflictSet?.entries.filter((entry) => entry.state === 'settled').length ?? 0
    const generation = JSON.stringify([state.actionId, state.syncConflictSet?.baseRevision, state.syncConflictSet?.revision,
      state.syncConflictSet?.entries.map((entry) => entry.path).sort()])
    const merger = state.execution?.merger
    const previous = state.conflictProgress?.generation === generation ? state.conflictProgress : undefined
    // A live merger keeps its paths when a settlement adds new ones; only its end gives them back.
    const owner = merger !== undefined && merger.endedAt === undefined ? 'merger' as const : previous?.owner ?? 'worker' as const
    const continuous = lastLookAt !== undefined && at - lastLookAt <= SvnMergerLauncher.lookGapMilliseconds
    let progress: NonNullable<import('../worktreeState').WorktreeLifecycle['conflictProgress']>
    if (previous === undefined || previous.settled !== settled || previous.owner !== owner)
      progress = { generation, owner, settled, observedAt: at, idle, milliseconds: 0 }
    else if (owner === 'merger' || previous.idle && idle && continuous) progress = previous
    else progress = { ...previous, observedAt: at, idle, milliseconds: previous.milliseconds + (previous.idle && continuous ? Math.max(0, at - previous.observedAt) : 0) }
    const changed = progress !== previous
    const elapsed = progress.milliseconds + (progress.owner === 'merger' || progress.idle ? Math.max(0, at - progress.observedAt) : 0)
    if (state.step !== 'worker-resolving' || !state.syncConflictSet?.entries.some((entry) => entry.state !== 'settled')) return { action: 'wait', progress, changed }
    if (progress.owner === 'worker') {
      if (state.wait?.kind === 'worker-lost' || elapsed >= SvnMergerLauncher.idleLimitMilliseconds)
        return { action: 'merger', progress: { ...progress, owner: 'merger', observedAt: at, milliseconds: 0 }, changed: true }
      return { action: 'wait', progress, changed }
    }
    else if (progress.owner === 'merger') return { action: elapsed >= SvnMergerLauncher.idleLimitMilliseconds ? 'person' : 'wait', progress, changed }
    else throw new Error(`Unknown conflict owner: ${JSON.stringify(progress.owner satisfies never)}`)
  }

  /**
   * What a drive does with a live merger: stop one that has no path an agent may settle left (the
   * worker or the person settled them), or that never confirmed its conversation within the start
   * limit. Null leaves it working; its idle limit stays with `fallback`.
   */
  static supervise(set: SvnActionConflictSet | undefined, merger: { startedAt: number }, confirmed: boolean, at: number): 'spent' | 'unstarted' | null {
    if (!(set?.entries ?? []).some((entry) => entry.state === 'agent')) return 'spent'
    if (!confirmed && at - merger.startedAt >= SvnMergerLauncher.startLimitMilliseconds) return 'unstarted'
    return null
  }

  /** The other commits' messages the brief quotes; the rest is counted. */
  private static readonly logEntriesConst = 20
  /** Lines of one message the brief quotes. */
  private static readonly messageLinesConst = 12

  /** The worker's Claude conversation when it ran in this worktree, else a fresh Claude; never print mode. */
  static specOf(parent: SessionRecord, input: { root: string; briefFile: string }): SessionCreateSpec {
    const prompt = SvnMergerLauncher.promptOf(input.briefFile)
    const title = `Merge conflicts ${basename(input.root)}`
    const fork = SvnResolverLauncher.forkOf(parent, input.root)
    return fork === null
      ? { kind: 'agent', directory: { mode: 'adHoc', path: input.root }, agent: { agentId: 'claude', mode: 'new', initialPrompt: prompt }, title }
      : {
        kind: 'agent',
        directory: { mode: 'adHoc', path: fork.cwd },
        agent: { agentId: 'claude', mode: 'fork', forkParentId: fork.nativeSessionId, initialPrompt: prompt },
        title,
      }
  }

  /** Interactive (no `oneShot`), with the merger's rights, a run of the action gate. */
  static marksOf(parentId: string, runId: string): SessionInternalMarks {
    return { sessionId: runId, permission: 'merger', scriptOf: SessionScriptDefinitions.linkOf(parentId, 'after', 'svn-merge', 'merger') }
  }

  /** One line: it travels as a command-line argument, and cmd.exe cuts one at its first newline. */
  static promptOf(briefFile: string): string {
    return `svn update in this working copy stopped on conflicts that Jamat's rules could not settle. Read ${briefFile} `
      + 'and settle every path it gives you, each with the one resolve-conflict call it names. Never run svn.'
  }

  /** Whether an agent may settle the entry: its shape lets one, and it admits an option that drops nothing incoming. */
  static forAgent(entry: SvnActionConflictEntry): boolean {
    return entry.state !== 'settled' && SvnConflictShapes.agentOf(entry.shape) && SvnMergerLauncher.agentOptionsOf(entry).length > 0
  }

  /**
   * Per path: what each side did, what Jamat did and saved where, what is left and the one call that
   * settles it; then the other commits' messages and the rules.
   */
  static briefOf(input: SvnMergerBriefInput): string {
    const settled = input.set.entries.filter((entry) => entry.state === 'settled')
    const agent = input.set.entries.filter(SvnMergerLauncher.forAgent)
    const person = input.set.entries.filter((entry) => entry.state !== 'settled' && !SvnMergerLauncher.forAgent(entry))
    const lines = [
      `# Merge the conflicts of ${input.title}`,
      '',
      `Working copy: \`${input.root}\``,
      '',
      `svn update took this working copy from r${input.set.baseRevision} to r${input.set.revision}, and the commits it brought `
        + `conflict with the changes of this session. ${SvnConflictWords.summaryOf(input.set)}.`,
      '',
      '## What Jamat already did',
      '',
      ...settled.length === 0 ? ['Nothing yet.'] : settled.map(SvnMergerLauncher.settledLineOf),
      '',
      '## What is left for you',
      '',
      ...agent.length === 0 ? ['Nothing.', ''] : agent.flatMap((entry) => SvnMergerLauncher.agentBlockOf(entry, input.cli,
        input.set.entries.some((other) => other !== entry && other.path === entry.path))),
      ...person.length === 0 ? [] : [
        '## Left for the person',
        '',
        'Do not touch these; the person settles them in the workflow.',
        '',
        ...person.map(SvnMergerLauncher.personLineOf),
        '',
      ],
      ...input.set.more > 0 ? [`${input.set.more} more conflicts are not listed here; \`${input.cli} sessions conflicts --self\` lists the set as it stands.`, ''] : [],
      '## What the other commits say',
      '',
      ...input.log.length === 0 ? ['svn log named no commit.'] : SvnMergerLauncher.logLinesOf(input.log),
      '',
      '## Rules',
      '',
      '- Never run svn or svnadmin: no commit, update, revert, resolve or add. Jamat refuses them and runs every svn write itself.',
      '- Edit only the files listed under "What is left for you". Create, delete or rename no other file.',
      '- Settle each path with exactly one `resolve-conflict` call once its file is as it should be. Each call answers how many are left;',
      '  after the last one Jamat stops you and goes on with the Finish.',
      '- Keep mine drops what the other commit brought in; only the person chooses it, in the window.',
      `- \`${input.cli} sessions conflicts --self\` lists the conflicts as they stand now.`,
      '',
    ]
    return lines.join('\n')
  }

  private static settledLineOf(entry: SvnActionConflictEntry): string {
    const description = SvnConflictWords.descriptionOf(entry)
    const how = entry.settledWith === undefined ? 'settled' : `settled with ${SvnConflictWords.optionWordOf(entry.settledWith)}`
    const by = entry.by === undefined ? 'svn' : SvnConflictWords.actorOf(entry.by, 'the person')
    const saved = entry.saved === undefined ? '' : `; what it replaced or moved aside is saved at \`${entry.saved}\``
    return `- \`${entry.path}\` (${entry.kind}): ${description} ${by} ${how}${saved}.`
  }

  /** `named`: the path holds another conflict too, so the call names this one's kind. */
  private static agentBlockOf(entry: SvnActionConflictEntry, cli: string, named: boolean): string[] {
    const options = SvnMergerLauncher.agentOptionsOf(entry)
    const info = SvnConflictWords.infoOf(entry)
    const word = (option: SvnConflictOption): string => info.options.find((candidate) => candidate.id === option)?.note ?? ''
    const left = SvnMergerLauncher.leftOf(entry)
    return [
      `### \`${entry.path}\` (${entry.kind})`,
      '',
      SvnConflictWords.descriptionOf(entry),
      '',
      left,
      '',
      ...options.length === 1 ? ['Settle it with:', ''] : ['Settle it with one of:', ''],
      ...options.flatMap((option) => [
        `- ${SvnConflictWords.optionWordOf(option)}: ${word(option)}`,
        '',
        '  ```',
        `  ${SvnMergerLauncher.callOf(cli, entry.path, option, named ? entry.kind : undefined)}`,
        '  ```',
        '',
      ]),
    ]
  }

  /** What is left on the path, in the merger's terms. */
  private static leftOf(entry: SvnActionConflictEntry): string {
    const kind = entry.kind
    const name = basename(entry.path)
    const revision = entry.facts.incomingRevision === undefined ? 'the other commit' : `r${entry.facts.incomingRevision}`
    switch (kind) {
      case 'text':
        return 'Left: the file holds svn\'s conflict blocks (`<<<<<<< .mine`, `||||||| .r<base>`, `=======`, `>>>>>>> .r<new>`). '
          + 'Edit it to the text that keeps the intent of both sides, with no marker line left, then settle it as merged.'
      case 'diverged':
        return `Left: ${name} exists on both sides: ${revision}'s in the working copy, yours at \`${entry.saved ?? 'the saved folder'}\`. `
          + 'Merge yours into the working-copy file, then settle it as merged.'
      case 'property':
        return `Left: the properties ${(entry.facts.properties ?? []).join(', ') || 'of this path'} conflict. You cannot set a property `
          + 'without svn, so choose the option whose result is right; merged keeps the working-copy value as it stands.'
      case 'tree':
        return 'Left: svn could not apply the other commit\'s change to this path. Choose the option whose result is right; '
          + 'make any file edits it needs first.'
      default: throw new Error(`Unknown conflict kind: ${JSON.stringify(kind satisfies never)}`)
    }
  }

  private static personLineOf(entry: SvnActionConflictEntry): string {
    const outside = entry.shape === 'name-unsafe' ? ' It is fixed outside Jamat, in an SVN client; no call settles it here.' : ''
    return `- \`${entry.path}\` (${entry.kind}): ${SvnConflictWords.descriptionOf(entry)}${outside}`
  }

  private static logLinesOf(log: readonly SvnLogEntry[]): string[] {
    const shown = log.slice(-SvnMergerLauncher.logEntriesConst)
    const rest = log.length - shown.length
    return [
      ...rest > 0 ? [`${rest} older commits are not quoted.`, ''] : [],
      ...shown.flatMap((entry) => {
        const message = entry.message.replace(/\r\n?/g, '\n').trim().split('\n')
        const quoted = message.slice(0, SvnMergerLauncher.messageLinesConst)
        return [
          `- r${entry.revision}${entry.author === null ? '' : ` by ${entry.author}`}:`,
          ...quoted.map((line) => `  > ${line}`),
          ...message.length > quoted.length ? [`  > (${message.length - quoted.length} more lines)`] : [],
        ]
      }),
    ]
  }

  /** The options an agent may choose: the entry's own, without one that drops what the other commit brought in. */
  private static agentOptionsOf(entry: SvnActionConflictEntry): SvnConflictOption[] {
    return entry.options.filter((option) => SvnConflictShapes.agentOption(entry.shape, entry.kind, option, entry.facts.properties))
  }

  /** The exact line the merger runs; a path outside plain characters is quoted for Claude's shell. */
  static callOf(cli: string, path: string, option: SvnConflictOption, kind?: SvnConflictKind): string {
    const argument = /^[A-Za-z0-9._/@+-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`
    return `${cli} sessions resolve-conflict --self --path ${argument}${kind === undefined ? '' : ` --kind ${kind}`} --option ${option}`
  }
}
