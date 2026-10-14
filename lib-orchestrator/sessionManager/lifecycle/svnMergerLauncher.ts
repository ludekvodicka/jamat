import { basename } from 'node:path'

import type { SvnConflictOption, SvnLogEntry } from '../../svn/svn.types'
import { SvnConflictShapes } from '../../svn/svnConflictShapes'
import type { SessionRecord, SvnActionConflictEntry, SvnActionConflictSet } from '../records/sessionRecord.types'
import { SessionScriptDefinitions } from '../scripts/sessionScriptDefinitions'
import type { SessionCreateSpec } from '../sessionManagerApi.types'
import type { SessionInternalMarks } from './sessionLifecycle'
import { SvnConflictWords } from './svnConflictWords'
import { SvnResolverLauncher } from './svnResolverLauncher'

/** What a brief is written from: the session, its working copy, the set, the other commits and the CLI line. */
export interface SvnMergerBriefInput {
  title: string
  root: string
  set: SvnActionConflictSet
  /** The commits the update brought, oldest first. */
  log: readonly SvnLogEntry[]
  /** The command line of the Jamat CLI, `AgentPresets.jamatCliOf`. */
  cli: string
}

/**
 * The interactive Claude merger of an SVN Finish: what it is started as and what it is told. It runs
 * in the worktree, decides each path the rules left and settles it with one
 * `jamat-v3 sessions resolve-conflict --self` call; Jamat runs every svn write. It forks the worker's
 * Claude conversation by the resolver's rule, so it knows why each change was made.
 */
export class SvnMergerLauncher {
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
      ...agent.length === 0 ? ['Nothing.', ''] : agent.flatMap((entry) => SvnMergerLauncher.agentBlockOf(entry, input.cli)),
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
    const by = entry.by === 'jamat' ? 'Jamat' : entry.by === 'agent' ? 'the merger' : entry.by === 'person' ? 'the person' : 'svn'
    const saved = entry.saved === undefined ? '' : `; what it replaced or moved aside is saved at \`${entry.saved}\``
    return `- \`${entry.path}\` (${entry.kind}): ${description} ${by} ${how}${saved}.`
  }

  private static agentBlockOf(entry: SvnActionConflictEntry, cli: string): string[] {
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
        `  ${SvnMergerLauncher.callOf(cli, entry.path, option)}`,
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
    return entry.options.filter((option) => SvnConflictShapes.lossOf(option) !== 'incoming')
  }

  /** The exact line the merger runs; a path outside plain characters is quoted for Claude's shell. */
  static callOf(cli: string, path: string, option: SvnConflictOption): string {
    const argument = /^[A-Za-z0-9._/@+-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`
    return `${cli} sessions resolve-conflict --self --path ${argument} --option ${option}`
  }
}
