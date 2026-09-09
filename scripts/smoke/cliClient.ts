import { spawn } from 'node:child_process'
import { join } from 'node:path'

import { RemoteControlConst } from '../../lib-orchestrator/remoteControl/remoteControlProtocol.js'
import { ChildEnvironment } from '../../lib-orchestrator/shared/childEnvironment.js'

/** One line of JSON the CLI wrote, as a smoke reads it back. */
export interface CliEnvelope {
  protocol: string
  operation: string | null
  ok: boolean
  value?: unknown
  error?: { code?: unknown; detail?: unknown }
}

export interface CliClientOptions {
  /** Where the CLI looks for the descriptor of the AppClientUI it is meant to reach. */
  configDir?: string
  channel?: string
  /** The working directory the CLI is run FROM, which is how it resolves a project. */
  cwd: string
  /** Optional private state root. Auto-discovery omits it to prove the stripped-agent environment. */
  stateRoot?: string
  timeoutMilliseconds: number
}

/**
 * Running the shipped CLI wrapper as a child and reading the one JSON line it answers with.
 *
 * Two smokes drive it - `remote-control.ts` and `remote-app.ts` - and held character-identical copies
 * of all of this: the envelope, the path to the wrapper, the spawn, the output limit, the timeout and
 * the four readers below. The point of driving the WRAPPER rather than the CLI's own class is that
 * the wrapper is what an agent actually executes, so its argument handling and its single-line output
 * are part of what is under test; two copies of that are two chances to test something else.
 */
export class CliClient {
  private static readonly outputLimitConst = 1_048_576
  private static readonly repoRootConst = join(import.meta.dirname, '..', '..')
  /**
   * What an agent executes: the skill's own wrapper, not `app-client-cli/start.ts`. The Claude
   * adapter rather than the Codex one because one of the two has to be named and
   * `scripts/checks/skills-adapters-identical.ts` keeps them byte-identical, so the choice cannot
   * decide what is tested. This pointed at a `skills/shared/` directory until 2026-09-07, which
   * r4052 dissolved into the two per-agent copies: the path had not existed since, and both smokes
   * failed on their first CLI call.
   */
  static readonly wrapperConst = join(
    CliClient.repoRootConst,
    'skills',
    'claude',
    'appjamat-v3',
    'scripts',
    'jamat-v3.mjs',
  )

  constructor(private readonly options: CliClientOptions) {}

  run(...args: string[]): Promise<CliEnvelope> {
    return this.execute([0], args)
  }

  runFailure(exitCode: number, ...args: string[]): Promise<CliEnvelope> {
    return this.execute([exitCode], args)
  }

  private execute(acceptedExitCodes: readonly number[], args: readonly string[]): Promise<CliEnvelope> {
    return new Promise((resolve, reject) => {
      const selectors = [
        ...(this.options.configDir === undefined
          ? []
          : ['--config-dir', this.options.configDir]),
        ...(this.options.channel === undefined
          ? []
          : ['--channel', this.options.channel]),
      ]
      const env: NodeJS.ProcessEnv = ChildEnvironment.withoutJamat(process.env)
      // After the filter, never inside it: the smoke's own state root IS a JAMAT_V3_* name.
      if (this.options.stateRoot !== undefined)
        env.JAMAT_V3_LOCAL_STATE_DIR = this.options.stateRoot
      const child = spawn(
        process.execPath,
        [
          CliClient.wrapperConst,
          ...args,
          ...selectors,
        ],
        {
          cwd: this.options.cwd,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      )
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) reject(error)
        else {
          try { resolve(CliClient.parse(stdout, stderr)) }
          catch (parseError) { reject(parseError) }
        }
      }
      // Bounded, because a CLI that never stops writing would otherwise take the smoke's memory
      // with it rather than failing it.
      const append = (current: string, chunk: Buffer): string => {
        const next = `${current}${chunk.toString()}`
        if (next.length > CliClient.outputLimitConst) {
          child.kill()
          finish(new Error('FAILED: AppJamatV3 CLI exceeded the smoke output limit'))
        }
        return next
      }
      child.stdout?.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk) })
      child.stderr?.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk) })
      child.once('error', (error) => finish(error))
      child.once('close', (code) => {
        if (code === null || !acceptedExitCodes.includes(code))
          finish(new Error(
            `FAILED: AppJamatV3 CLI exited ${String(code)}: ${stderr.trim()} ${stdout.trim()}`,
          ))
        else finish()
      })
      const timer = setTimeout(() => {
        child.kill()
        finish(new Error('FAILED: AppJamatV3 CLI timed out'))
      }, this.options.timeoutMilliseconds)
    })
  }

  /**
   * ONE line and nothing on stderr, which is the CLI's whole output contract: an agent pipes it into
   * a JSON reader, and a second line or a warning would be that reader's problem rather than ours.
   */
  static parse(stdout: string, stderr: string): CliEnvelope {
    if (stderr.trim().length > 0)
      throw new Error(`FAILED: AppJamatV3 CLI wrote stderr: ${stderr.trim()}`)
    const lines = stdout.trim().split(/\r?\n/)
    if (lines.length !== 1 || lines[0]?.length === 0)
      throw new Error(`FAILED: AppJamatV3 CLI wrote ${lines.length} JSON lines`)
    let parsed: unknown
    try { parsed = JSON.parse(lines[0]) } catch {
      throw new Error(`FAILED: AppJamatV3 CLI wrote invalid JSON: ${lines[0]}`)
    }
    const envelope = CliClient.object(parsed, 'CLI envelope')
    if (envelope.protocol !== RemoteControlConst.protocol || typeof envelope.ok !== 'boolean')
      throw new Error(`FAILED: invalid AppJamatV3 CLI envelope: ${lines[0]}`)
    return envelope as unknown as CliEnvelope
  }

  /**
   * The answer of an envelope that worked, and the operation read BACK: a CLI that answered a
   * different operation than the one asked for has not failed, it has answered something else, and
   * an assertion on its value would be an assertion about the wrong call.
   */
  static valueOf(envelope: CliEnvelope, operation: string): Record<string, unknown> {
    if (envelope.operation !== operation)
      throw new Error(`FAILED: expected ${operation}, got ${String(envelope.operation)}`)
    if (!envelope.ok)
      throw new Error(
        `FAILED: ${operation} refused with ${String(envelope.error?.code)}: ${
          String(envelope.error?.detail)}`,
      )
    return CliClient.object(envelope.value, `${operation} value`)
  }

  static object(value: unknown, what: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      throw new Error(`FAILED: ${what} is not an object`)
    return value as Record<string, unknown>
  }

  static array(value: unknown, what: string): unknown[] {
    if (!Array.isArray(value)) throw new Error(`FAILED: ${what} is not an array`)
    return value
  }

  static text(value: unknown, what: string): string {
    if (typeof value !== 'string' || value.length === 0)
      throw new Error(`FAILED: ${what} is not a non-empty string`)
    return value
  }
}
