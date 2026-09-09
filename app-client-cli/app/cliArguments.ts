import { AppClientCliError } from './appClientCliError'

interface CliCommandSpec {
  options: readonly string[]
  flags: readonly string[]
  mutation: boolean
}

export type CliCommand = keyof typeof CliArguments['commandSpecsConst']

export class CliArguments {
  private static readonly remoteComputerOptionConst = '--computer'
  private static readonly globalOptionsConst = [
    '--config-dir',
    '--config-identity',
    '--channel',
    '--operation-id',
  ] as const
  /**
   * Every command this CLI has, as an object rather than a Map, so the KEYS are a type: the
   * dispatch that reads `args.command` is exhaustive only if the compiler knows
   * what the sixteen are.
   */
  private static readonly commandSpecsConst = {
    'status': { options: [CliArguments.remoteComputerOptionConst], flags: [], mutation: false },
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
        '--mode',
        '--native-session-id',
        '--fork-parent-id',
        '--prompt',
        '--worktree',
        '--base-ref',
        '--title',
        '--flow-id',
        '--acknowledge-setup',
        CliArguments.remoteComputerOptionConst,
      ],
      flags: ['--plain', '--open-tab'],
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
        CliArguments.remoteComputerOptionConst,
      ],
      flags: [],
      mutation: true,
    },
    'sessions transcript': {
      options: ['--session-id', '--number', '--working-directory'],
      flags: [],
      mutation: false,
    },
    'tabs list': { options: [], flags: [], mutation: false },
    'tabs open': {
      options: ['--session-id', '--number', '--working-directory'],
      flags: [],
      mutation: true,
    },
    'tabs open-file': {
      options: ['--session-id', '--number', '--working-directory', '--path'],
      flags: [],
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
    'events watch': { options: ['--after-revision'], flags: [], mutation: false },
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
      if (CliArguments.knownFlags.has(token)) {
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
    return new CliArguments(command, options, flags, spec.mutation)
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
