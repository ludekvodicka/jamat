import { AppClientCliError } from './appClientCliError'

interface CliCommandSpec {
  options: readonly string[]
  flags: readonly string[]
  mutation: boolean
}

export type CliCommand = keyof typeof CliArguments['commandSpecsConst']

export interface CliUsage {
  usage: string
  sessionSelector: string
  globalOptions: string[]
  commands: { command: string; options: string[]; flags: string[] }[]
}

export class CliArguments {
  private static readonly remoteComputerOptionConst = '--computer'
  private static readonly sessionIdPatternConst = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  private static readonly globalOptionsConst = [
    '--config-dir',
    '--config-identity',
    '--channel',
    '--operation-id',
  ] as const
  /**
   * Every command this CLI has, as an object rather than a Map, so the KEYS are a type: the
   * dispatch that reads `args.command` is exhaustive only if the compiler knows what they are. No
   * count is written here, because a count is a second statement of the list that ages on the next
   * command.
   */
  private static readonly commandSpecsConst = {
    'snapins pass brief': { options: ['--pass'], flags: [], mutation: false },
    'snapins pass event': { options: ['--pass', '--kind', '--agent', '--pp-version', '--trail', '--outcome', '--waiting', '--detail-file', '--note-file', '--report-file'], flags: [], mutation: false },
    'commit-svn-jamat': { options: ['--session-id', '--number', '--working-directory', '--path', '--paths-file', '--message', '--message-file', '--fallback', '--timeout-ms'], flags: ['--self', '--wait'], mutation: true },
    'commit-git-jamat': { options: ['--session-id', '--number', '--working-directory', '--path', '--paths-file', '--message', '--message-file', '--fallback', '--timeout-ms'], flags: ['--self', '--wait'], mutation: true },
    'commit status': { options: ['--commit-session-id', '--timeout-ms'], flags: ['--wait'], mutation: false },
    'commit cancel': { options: ['--commit-session-id'], flags: [], mutation: true },
    /* A worker's message for its worktree's review; nothing opens and nothing is committed. */
    'commit propose': { options: ['--message', '--message-file', '--directory'], flags: ['--self'], mutation: true },
    'status': { options: [CliArguments.remoteComputerOptionConst], flags: [], mutation: false },
    'accounts list': { options: [CliArguments.remoteComputerOptionConst], flags: [], mutation: false },
    'projects list': {
      options: ['--category-id', '--sort', CliArguments.remoteComputerOptionConst],
      flags: [],
      mutation: false,
    },
    'sessions list': {
      options: [CliArguments.remoteComputerOptionConst],
      flags: [],
      mutation: false,
    },
    'sessions create': {
      options: [
        '--directory',
        '--category-id',
        '--project-path',
        '--agent',
        '--account',
        '--mode',
        '--native-session-id',
        '--fork-parent-id',
        '--prompt',
        '--worktree',
        '--worktree-owner',
        '--worktree-tag',
        '--worktree-notify-session',
        '--worktree-notify-text',
        '--notify-session',
        '--notify-text',
        '--notify-on-group',
        '--parent-session',
        '--parent-kind',
        '--base-ref',
        '--title',
        '--number',
        '--color',
        '--group',
        '--flow-id',
        '--acknowledge-setup',
        CliArguments.remoteComputerOptionConst,
      ],
      flags: ['--open-tab', '--worktree-remove-when-ended'],
      mutation: true,
    },
    'sessions reopen': {
      options: [
        '--session-id',
        '--number',
        '--working-directory',
        CliArguments.remoteComputerOptionConst,
      ],
      flags: [],
      mutation: true,
    },
    'sessions finalize': {
      options: [
        '--session-id',
        '--number',
        '--working-directory',
        '--expect',
        '--acknowledge-setup',
        CliArguments.remoteComputerOptionConst,
      ],
      flags: [],
      mutation: true,
    },
    'sessions worktree': {
      options: [CliArguments.remoteComputerOptionConst, '--session-id', '--number', '--working-directory'],
      flags: ['--self'],
      mutation: false,
    },
    'sessions remove': {
      options: [CliArguments.remoteComputerOptionConst, '--session-id', '--number', '--working-directory'],
      flags: [],
      mutation: true,
    },
    'sessions discard-worktree': {
      options: [CliArguments.remoteComputerOptionConst, '--session-id', '--number', '--working-directory'],
      flags: [],
      mutation: true,
    },
    'sessions retry-setup': {
      options: [CliArguments.remoteComputerOptionConst, '--session-id', '--number', '--working-directory', '--acknowledge-setup'],
      flags: [],
      mutation: true,
    },
    'sessions cleanup-worktree': {
      options: [CliArguments.remoteComputerOptionConst, '--session-id', '--number', '--working-directory'],
      flags: [],
      mutation: true,
    },
    'sessions finish-worktree': {
      options: [CliArguments.remoteComputerOptionConst, '--session-id', '--number', '--working-directory', '--choice', '--acknowledge-setup'],
      flags: ['--self', '--confirm-working', '--agent', '--refresh-preparation'],
      mutation: true,
    },
    'sessions update-main': {
      options: [CliArguments.remoteComputerOptionConst, '--session-id', '--number', '--working-directory', '--confirm-live'],
      flags: ['--self'],
      mutation: true,
    },
    'sessions worktree-results': { options: [CliArguments.remoteComputerOptionConst, '--tag', '--session-id'], flags: ['--unacknowledged'], mutation: false },
    'sessions notifies': { options: ['--session-id'], flags: [], mutation: false },
    'sessions sync': { options: [CliArguments.remoteComputerOptionConst, '--session-id', '--number', '--working-directory'], flags: ['--self'], mutation: true },
    'sessions conflicts': { options: [CliArguments.remoteComputerOptionConst, '--session-id', '--number', '--working-directory'], flags: ['--self'], mutation: false },
    /* No confirm flag: an option that loses incoming work is the person's, in the window. */
    'sessions resolve-conflict': { options: [CliArguments.remoteComputerOptionConst, '--session-id', '--number', '--working-directory', '--path', '--kind', '--option'], flags: ['--self'], mutation: true },
    'sessions back-to-work': { options: [CliArguments.remoteComputerOptionConst, '--session-id', '--number', '--working-directory'], flags: ['--self'], mutation: true },
    'sessions solve-with-agent': {
      options: ['--session-id', '--number', '--working-directory'],
      flags: [],
      mutation: true,
    },
    'sessions children': { options: [CliArguments.remoteComputerOptionConst, '--session-id'], flags: [], mutation: false },
    'sessions acknowledge-worktree-result': { options: [CliArguments.remoteComputerOptionConst, '--action-id'], flags: [], mutation: true },
    'sessions transcript': {
      options: [CliArguments.remoteComputerOptionConst, '--session-id', '--number', '--working-directory'],
      flags: [],
      mutation: false,
    },
    'sessions scripts': {
      options: [CliArguments.remoteComputerOptionConst, '--session-id', '--number', '--working-directory', '--run-id'],
      flags: ['--self'],
      mutation: false,
    },
    'sessions scripts run': {
      options: ['--session-id', '--number', '--working-directory', '--command', '--cwd', '--title', '--timeout-ms'],
      flags: ['--self', '--wait'],
      mutation: true,
    },
    'sessions color': {
      options: [
        '--session-id',
        '--number',
        '--working-directory',
        '--color',
        CliArguments.remoteComputerOptionConst,
      ],
      flags: [],
      mutation: true,
    },
    'sessions group': {
      options: [
        '--session-id',
        '--number',
        '--working-directory',
        '--group',
        CliArguments.remoteComputerOptionConst,
      ],
      flags: [],
      mutation: true,
    },
    /*
     * Three forms in one command, because they are one question about one field: with neither flag
     * it READS the note, `--note` writes it and `--clear` takes it away. It is declared a mutation
     * so `--operation-id` is accepted; the read form sends none, the way every other read does.
     */
    'sessions note': {
      options: [
        '--session-id',
        '--number',
        '--working-directory',
        '--note',
        CliArguments.remoteComputerOptionConst,
      ],
      flags: ['--clear', '--self'],
      mutation: true,
    },
    'tabs list': { options: [], flags: [], mutation: false },
    'tabs open': {
      options: ['--session-id', '--number', '--working-directory'],
      flags: [],
      mutation: true,
    },
    'tabs open-file': {
      options: ['--session-id', '--number', '--working-directory', '--path', CliArguments.remoteComputerOptionConst],
      flags: ['--self'],
      mutation: true,
    },
    'tabs focus': { options: ['--panel-id'], flags: [], mutation: true },
    'tabs close': { options: ['--panel-id'], flags: [], mutation: true },
    'terminal peek': {
      options: [
        '--session-id',
        '--number',
        '--working-directory',
        '--cols',
        '--rows',
        '--timeout-ms',
        CliArguments.remoteComputerOptionConst,
      ],
      flags: [],
      mutation: false,
    },
    'terminal send': {
      options: [
        '--session-id',
        '--number',
        '--working-directory',
        '--text',
        '--timeout-ms',
        CliArguments.remoteComputerOptionConst,
      ],
      flags: ['--enter'],
      mutation: true,
    },
    'terminal deliver': {
      options: [
        '--session-id',
        '--number',
        '--working-directory',
        '--text',
        '--ready-timeout-ms',
        '--submit-timeout-ms',
      ],
      flags: ['--typed', '--queue'],
      mutation: true,
    },
    'events watch': { options: ['--after-revision'], flags: [], mutation: false },
    /*
     * The registry's own surface: every operation by name, the window's included. `call` takes the
     * body as JSON text or a file and adds an operation id when the catalog says the call writes.
     */
    'operations list': { options: [], flags: [], mutation: false },
    'operations get': { options: ['--operation'], flags: [], mutation: false },
    'call': { options: ['--operation', '--body', '--body-file'], flags: [], mutation: true },
    'calls list': { options: [], flags: [], mutation: false },
    'events poll': { options: ['--after', '--wait-ms'], flags: [], mutation: false },
    'remote computers list': { options: [], flags: [], mutation: false },
    'remote pairing export': { options: [], flags: [], mutation: false },
    'remote pairing import': { options: ['--file'], flags: [], mutation: true },
  } as const satisfies Record<string, CliCommandSpec>

  private static readonly knownOptions = new Set<string>([
    ...CliArguments.globalOptionsConst,
    ...Object.values(CliArguments.commandSpecsConst).flatMap((spec) => [...spec.options]),
  ])
  private static readonly knownFlags = new Set<string>(
    Object.values(CliArguments.commandSpecsConst).flatMap((spec) => [...spec.flags]),
  )

  private constructor(
    readonly command: CliCommand,
    private readonly options: ReadonlyMap<string, string>,
    private readonly flags: ReadonlySet<string>,
    readonly mutation: boolean,
  ) {}

  static parse(args: readonly string[]): CliArguments {
    const positionals: string[] = []
    const options = new Map<string, string>()
    const flags = new Set<string>()
    for (let index = 0; index < args.length; index += 1) {
      const token = args[index] ?? ''
      if (!token.startsWith('--')) {
        positionals.push(token)
        continue
      }
      // `--agent` is both: the agent of `sessions create` takes a value, the press of `finish-worktree` none.
      const valued = CliArguments.knownOptions.has(token) && args[index + 1] !== undefined && !(args[index + 1] ?? '').startsWith('--')
      if (CliArguments.knownFlags.has(token) && !valued) {
        if (flags.has(token)) throw CliArguments.usage(`Argument ${token} was provided twice`)
        flags.add(token)
        continue
      }
      if (!CliArguments.knownOptions.has(token))
        throw CliArguments.usage(`Unknown argument ${token}`)
      if (options.has(token)) throw CliArguments.usage(`Argument ${token} was provided twice`)
      const value = args[index + 1]
      if (value === undefined || value.startsWith('--'))
        throw CliArguments.usage(`Argument ${token} requires a value`)
      options.set(token, value)
      index += 1
    }

    CliArguments.takeBareSessionId(positionals, options, flags)
    const command = positionals.length === 0
      ? 'status'
      : positionals.length === 1
        ? positionals[0] ?? ''
        : positionals.length === 2
          ? `${positionals[0]} ${positionals[1]}`
          : positionals.join(' ')
    if (!CliArguments.isCommand(command))
      throw CliArguments.usage(`Unknown command ${JSON.stringify(command)}`)
    const spec: CliCommandSpec = CliArguments.commandSpecsConst[command]
    if (command.startsWith('snapins pass ') && CliArguments.globalOptionsConst.some((option) => options.has(option)))
      throw CliArguments.usage('Pass commands derive their controller only from --pass')
    for (const option of options.keys())
      if (!(CliArguments.globalOptionsConst as readonly string[]).includes(option)
        && !spec.options.includes(option))
        throw CliArguments.usage(`Argument ${option} is not valid for ${command}`)
    for (const flag of flags)
      if (!spec.flags.includes(flag))
        throw CliArguments.usage(`Argument ${flag} is not valid for ${command}`)
    if (!spec.mutation && options.has('--operation-id'))
      throw CliArguments.usage(`Argument --operation-id is not valid for ${command}`)
    if (options.has('--config-dir') && options.has('--config-identity'))
      throw CliArguments.usage('--config-dir and --config-identity are mutually exclusive')
    if (flags.has('--self') && ['--session-id', '--number', '--working-directory', '--config-dir', '--config-identity'].some((key) => options.has(key)))
      throw CliArguments.usage('--self cannot be combined with a session or controller selector')
    if (options.has('--message') && options.has('--message-file'))
      throw CliArguments.usage('--message and --message-file are mutually exclusive')
    if (options.has('--body') && options.has('--body-file'))
      throw CliArguments.usage('--body and --body-file are mutually exclusive')
    return new CliArguments(command, options, flags, spec.mutation)
  }

  /**
   * `--help` or `-h` anywhere answers the usage of the commands its leading words name, or of
   * every command when they name none, before any other argument is checked.
   */
  static helpOf(args: readonly string[]): CliUsage | null {
    // `-h` may be the text an option sends (`terminal send --text -h`); `--help` never is a value.
    if (!args.some((arg, index) => arg === '--help' || arg === '-h' && !CliArguments.knownOptions.has(args[index - 1] ?? ''))) return null
    const prefix = args.slice(0, args.findIndex((arg) => arg.startsWith('-'))).join(' ')
    const all = Object.entries(CliArguments.commandSpecsConst)
    const named = all.filter(([command]) => command === prefix || command.startsWith(`${prefix} `))
    return {
      usage: 'jamat-v3 <command> [options]; every answer is one JSON envelope',
      sessionSelector: '--session-id <id> or a bare session UUID, --number <number> [--working-directory <dir>], '
        + 'or --self inside a Jamat session for a command whose flags list it',
      globalOptions: [...CliArguments.globalOptionsConst],
      commands: (named.length > 0 ? named : all)
        .map(([command, spec]) => ({ command, options: [...spec.options], flags: [...spec.flags] })),
    }
  }

  /**
   * A lone session UUID after the words of a command that takes `--session-id` is that option:
   * agents write `tabs open-file <id> --path x` from the command table. Any other selector beside it
   * would leave two sessions named, so that is refused instead of choosing one.
   */
  private static takeBareSessionId(positionals: string[], options: Map<string, string>, flags: ReadonlySet<string>): void {
    const last = positionals.at(-1)
    if (positionals.length < 2 || last === undefined || !CliArguments.sessionIdPatternConst.test(last)) return
    const command = positionals.slice(0, -1).join(' ')
    if (!CliArguments.isCommand(command)) return
    const spec: CliCommandSpec = CliArguments.commandSpecsConst[command]
    if (!spec.options.includes('--session-id')) return
    if (options.has('--session-id') || options.has('--number') || flags.has('--self'))
      throw CliArguments.usage(`${last} names a second session for ${command}; give only one of a bare session id, --session-id, --number or --self`)
    options.set('--session-id', last)
    positionals.pop()
  }

  private static isCommand(value: string): value is CliCommand {
    return Object.hasOwn(CliArguments.commandSpecsConst, value)
  }

  option(name: string): string | null {
    return this.options.get(name) ?? null
  }

  has(name: string): boolean {
    return this.flags.has(name)
  }

  required(name: string): string {
    const value = this.option(name)
    if (value === null) throw CliArguments.usage(`${name} is required for ${this.command}`)
    return value
  }

  integer(name: string, minimum: number, maximum: number): number | undefined {
    const raw = this.option(name)
    if (raw === null) return undefined
    const value = Number(raw)
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
      throw CliArguments.usage(`${name} must be an integer from ${minimum} through ${maximum}`)
    return value
  }

  private static usage(detail: string): AppClientCliError {
    return new AppClientCliError('invalid-request', detail)
  }
}
