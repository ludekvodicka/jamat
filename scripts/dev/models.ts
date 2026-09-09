/**
 * Prints the model list `app-client-ui/shared/agentModels.ts` holds, in the exact shape that file
 * wants, so refreshing it is a paste rather than research.
 *
 *   pnpm dev:models
 *
 * It is here rather than in the product because the product does not enumerate models. Stage 2 of
 * the default-model plan was a live catalog once - a library subsystem, two sources, a disk cache
 * with a TTL, an IPC channel - and it was replaced on 2026-08-24 by a list somebody writes down,
 * because the ids do not move: the Codex catalog is identical across three CLI releases. What DOES
 * move is the effort lists, which is why this exists at all: a hand-kept list nobody can refresh in
 * one command is a hand-kept list that rots.
 *
 * This is the ONE place in the tree that reads the Claude OAuth token for a model list and calls
 * `api.anthropic.com` for one. It runs when a person runs it.
 *
 * Neither half is required. A machine without Codex, and one that never logged in, each print what
 * they can and say what is missing - the point is to get the half that works, not to be complete.
 */
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'

import { ChildEnvironment } from '../../lib-orchestrator/shared/childEnvironment'
import { ClaudeCredentialsReader } from '../../lib-orchestrator/rateMonitor/claude/claudeCredentialsReader'
import { ErrorText } from '../../lib-orchestrator/shared/errorText'

type CommandAnswer =
  | { ok: true; text: string }
  | { ok: false; reason: string }

interface PrintedOption {
  id: string
  label: string
  kind: 'alias' | 'version'
  context: number
  efforts: readonly string[]
  note?: string
}

class DevModels {
  private static readonly modelsUrlConst = 'https://api.anthropic.com/v1/models?limit=100'
  private static readonly betaHeaderConst = 'oauth-2025-04-20'
  private static readonly versionHeaderConst = '2023-06-01'
  /** The installed Claude Code's, the way `RateLimitSourceClaude` carries one: read off a live 200. */
  private static readonly userAgentConst = 'claude-code/2.1.241'
  private static readonly requestTimeoutMillisecondsConst = 15_000
  private static readonly spawnTimeoutMillisecondsConst = 30_000
  /** The measured answer is 303 KB, almost all of it system prompts. Anything past this is not one. */
  private static readonly maximumBytesConst = 4_194_304
  private static readonly millionTokensConst = 1_000_000
  private static readonly twoHundredThousandTokensConst = 200_000
  private static readonly millionSuffixConst = '[1m]'
  /**
   * The endpoint knows no aliases, so they are written here. `opus` and its three siblings are the
   * entries that never go stale: they follow the newest model of their family on their own.
   *
   * `opusplan` and `default` are measured to work and are deliberately NOT offered: `default` is
   * what an empty field already means, and `opusplan` picks a model per mode rather than naming one.
   */
  private static readonly aliasesConst: readonly { id: string; family: string; label: string }[] = [
    { id: 'opus', family: 'opus', label: 'Opus' },
    { id: 'sonnet', family: 'sonnet', label: 'Sonnet' },
    { id: 'haiku', family: 'haiku', label: 'Haiku' },
    { id: 'fable', family: 'fable', label: 'Fable' },
  ]

  static async run(): Promise<void> {
    const claude = await DevModels.claudeOptions()
    const codex = await DevModels.codexOptions()
    console.log('// Measured ' + new Date().toISOString().slice(0, 10)
      + ` against ${DevModels.userAgentConst} and ${await DevModels.codexVersion()}.`)
    console.log('')
    DevModels.printSection('claudeConst', claude)
    console.log('')
    DevModels.printSection('codexConst', codex)
  }

  private static printSection(name: string, options: readonly PrintedOption[] | string): void {
    if (typeof options === 'string') {
      console.log(`  // ${name}: ${options}`)
      return
    }
    console.log(`  private static readonly ${name}: readonly AgentModelOption[] = [`)
    for (const option of options) {
      const efforts = `efforts: [${option.efforts.map((e) => DevModels.quote(e)).join(', ')}]`
      console.log(`    { id: ${DevModels.quote(option.id)},`
        + ` label: ${DevModels.quote(option.label)},`)
      console.log(`      kind: '${option.kind}', context: ${DevModels.number(option.context)},`)
      if (option.note === undefined) console.log(`      ${efforts} },`)
      else {
        console.log(`      ${efforts},`)
        console.log(`      note: ${DevModels.quote(option.note)} },`)
      }
    }
    console.log('  ]')
  }

  /**
   * The alias entries first, then every id the endpoint lists, and a `[1m]` twin for each id whose
   * ceiling is a million. The window written down is what a SESSION gets, which is the suffix rule
   * `ClaudeContextWindows` encodes and not the ceiling the endpoint reports: a bare id is 200k.
   */
  private static async claudeOptions(): Promise<readonly PrintedOption[] | string> {
    const credentials = await new ClaudeCredentialsReader().read()
    if (credentials.kind === 'missing')
      return `not printed - ${credentials.reason}`
    const answer = await DevModels.fetchModels(credentials.accessToken)
    if (!answer.ok) return `not printed - ${answer.reason}`
    let body: unknown
    try {
      body = JSON.parse(answer.text)
    } catch (error) {
      return `not printed - the models endpoint answered no readable JSON `
        + `(${ErrorText.of(error)})`
    }
    const data = DevModels.arrayOf(DevModels.recordOf(body)?.['data'])
    if (data === null) return 'not printed - the models endpoint answered no data array'
    const versions: PrintedOption[] = []
    for (const entry of data) {
      const record = DevModels.recordOf(entry)
      const id = record?.['id']
      if (typeof id !== 'string' || id.length === 0) continue
      const label = typeof record?.['display_name'] === 'string' ? record['display_name'] : id
      const efforts = DevModels.effortsOf(record?.['capabilities'])
      versions.push({
        id,
        label,
        kind: 'version',
        context: DevModels.twoHundredThousandTokensConst,
        efforts,
      })
      if (record?.['max_input_tokens'] === DevModels.millionTokensConst)
        versions.push({
          id: `${id}${DevModels.millionSuffixConst}`,
          label: `${label} (1M context)`,
          kind: 'version',
          context: DevModels.millionTokensConst,
          efforts,
        })
    }
    return [...DevModels.aliasOptions(versions), ...versions]
  }

  /**
   * An alias takes the efforts and the ceiling of the NEWEST model of its family, which is the one
   * it resolves to. The endpoint answers newest first, so that is the first match.
   */
  private static aliasOptions(versions: readonly PrintedOption[]): readonly PrintedOption[] {
    const options: PrintedOption[] = []
    for (const alias of DevModels.aliasesConst) {
      const newest = versions.find((option) => option.id.startsWith(`claude-${alias.family}-`))
      if (newest === undefined) continue
      options.push({
        id: alias.id,
        label: `${alias.label} (newest)`,
        kind: 'alias',
        context: DevModels.twoHundredThousandTokensConst,
        efforts: newest.efforts,
        note: `always the newest ${alias.label}`,
      })
      const million = versions.some(
        (option) => option.id === `${newest.id}${DevModels.millionSuffixConst}`,
      )
      if (million)
        options.push({
          id: `${alias.id}${DevModels.millionSuffixConst}`,
          label: `${alias.label} (newest, 1M context)`,
          kind: 'alias',
          context: DevModels.millionTokensConst,
          efforts: newest.efforts,
        })
    }
    return options
  }

  /**
   * A level is a RECORD carrying its own `supported`, not a boolean, and the levels of a model
   * that supports none are all present and all false. Reading `effort[level]` for truth would
   * therefore give every model every level.
   */
  private static effortsOf(capabilities: unknown): readonly string[] {
    const effort = DevModels.recordOf(DevModels.recordOf(capabilities)?.['effort'])
    if (effort === null || effort['supported'] !== true) return []
    return ['low', 'medium', 'high', 'xhigh', 'max']
      .filter((level) => DevModels.recordOf(effort[level])?.['supported'] === true)
  }

  private static async fetchModels(accessToken: string): Promise<CommandAnswer> {
    let response: Response
    try {
      response = await fetch(DevModels.modelsUrlConst, {
        headers: {
          'authorization': `Bearer ${accessToken}`,
          'anthropic-beta': DevModels.betaHeaderConst,
          'anthropic-version': DevModels.versionHeaderConst,
          'user-agent': DevModels.userAgentConst,
        },
        signal: AbortSignal.timeout(DevModels.requestTimeoutMillisecondsConst),
      })
    } catch (error) {
      // The token never reaches this line: `fetch` quotes a rejected header value back in full, so
      // only the class of failure is printed, the way `RateLimitSourceClaude` does it.
      return {
        ok: false,
        reason: `the models endpoint could not be reached (${ErrorText.of(error)})`,
      }
    }
    if (!response.ok)
      return { ok: false, reason: `the models endpoint answered ${response.status}` }
    const text = await response.text()
    if (text.length > DevModels.maximumBytesConst)
      return { ok: false, reason: 'the models endpoint answered more than a model list can be' }
    return { ok: true, text }
  }

  /**
   * `codex debug models` renders the raw catalog. Only `visibility: list` belongs in a picker; the
   * others are not meant to be chosen. Codex has NO aliases - `-m gpt-5.6` is a 400 that ends the
   * run - so every entry here is an exact slug.
   */
  private static async codexOptions(): Promise<readonly PrintedOption[] | string> {
    const answer = await DevModels.runCodex(['debug', 'models'])
    if (!answer.ok) return `not printed - ${answer.reason}`
    let parsed: unknown
    try {
      parsed = JSON.parse(answer.text)
    } catch (error) {
      return `not printed - codex debug models wrote no readable JSON (${ErrorText.of(error)})`
    }
    const models = DevModels.arrayOf(DevModels.recordOf(parsed)?.['models'])
    if (models === null) return 'not printed - codex debug models wrote no models array'
    const options: PrintedOption[] = []
    for (const entry of models) {
      const record = DevModels.recordOf(entry)
      if (record === null || record['visibility'] !== 'list') continue
      const id = record['slug']
      if (typeof id !== 'string' || id.length === 0) continue
      const context = record['context_window']
      const levels = DevModels.arrayOf(record['supported_reasoning_levels']) ?? []
      const option: PrintedOption = {
        id,
        label: typeof record['display_name'] === 'string' ? record['display_name'] : id,
        kind: 'version',
        context: typeof context === 'number' ? context : 0,
        efforts: levels
          .map((level) => DevModels.recordOf(level)?.['effort'])
          .filter((effort): effort is string => typeof effort === 'string'),
      }
      if (typeof record['description'] === 'string' && record['description'].length > 0)
        option.note = record['description']
      options.push(option)
    }
    return options
  }

  private static async codexVersion(): Promise<string> {
    const answer = await DevModels.runCodex(['--version'])
    return answer.ok ? answer.text.trim() : 'an unknown Codex CLI'
  }

  /**
   * Windows is why the wrap exists: `codex` installs as a `.cmd` shim there, which no spawn can
   * execute directly. `cwd` is the home directory rather than this repository, because `cmd /c`
   * searches the CURRENT directory before PATH. The environment loses every `JAMAT*` variable, the
   * same filter `LaunchPlanner` uses, so a terminal opened inside another generation of Jamat does
   * not reach this child.
   */
  private static runCodex(args: readonly string[]): Promise<CommandAnswer> {
    return new Promise<CommandAnswer>((settle) => {
      const win32 = process.platform === 'win32'
      const command = win32 ? process.env.ComSpec ?? 'cmd.exe' : 'codex'
      const spawnArgs = win32 ? ['/d', '/q', '/c', 'codex', ...args] : [...args]
      const child = spawn(command, spawnArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        cwd: homedir(),
        env: ChildEnvironment.withoutJamat(process.env),
      })
      let out = ''
      let bytes = 0
      let stderr = ''
      let done = false
      const finish = (value: CommandAnswer): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        settle(value)
      }
      const failed = (reason: string): void => finish({ ok: false, reason })
      const timer = setTimeout(() => {
        child.kill()
        failed(`codex ${args.join(' ')} did not answer in `
          + `${DevModels.spawnTimeoutMillisecondsConst / 1000}s`)
      }, DevModels.spawnTimeoutMillisecondsConst)
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > DevModels.maximumBytesConst) {
          child.kill()
          failed(`codex ${args.join(' ')} wrote more than a catalog can be`)
          return
        }
        out += chunk.toString('utf8')
      })
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
      child.once('error', (error) => failed(`codex could not be started (${ErrorText.of(error)})`))
      child.once('exit', (code) => {
        if (code === 0) finish({ ok: true, text: out })
        else failed(`codex ${args.join(' ')} exited ${code}: ${stderr.trim() || 'no message'}`)
      })
    })
  }

  /** Underscored the way the constant writes them, so a paste needs no reformatting. */
  private static number(value: number): string {
    return value.toLocaleString('en-US').replace(/,/g, '_')
  }

  private static quote(value: string): string {
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, ' ')}'`
  }

  private static recordOf(value: unknown): Record<string, unknown> | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    return value as Record<string, unknown>
  }

  private static arrayOf(value: unknown): unknown[] | null {
    return Array.isArray(value) ? value : null
  }
}

void DevModels.run().catch((error: unknown) => {
  console.error(`dev-models: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
