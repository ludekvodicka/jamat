import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { IdentityReceiptFile } from './identityReceiptFile'
import type { RunTools } from './runTools'

export interface AntigravitySessionStatus {
  launchId: string
  updatedAt: number
  agentState: string | null
  toolConfirmationPending: boolean
  taskCount: number
  runningSubagents: number
}

/** What an Antigravity settings file says about the status line, as far as a relay has to repeat it. */
type AntigravityStatusLineSetting = Record<string, unknown> & { type?: string; command: string }

/**
 * The status line relay every interactive Antigravity (`agy`) session is started with.
 *
 * Antigravity CLI accepts `--settings <file>` for session-only settings (never saved) and supports a
 * `statusLine` command block that receives the active session state as JSON on stdin — including
 * `conversation_id` / `session_id`, `model`, `context_window`, and `transcript_path`.
 *
 * Passing `"stack_with_default": true` keeps Antigravity's built-in status line intact when the user
 * has no custom status line of their own, while the relay prints nothing and records:
 * 1. An identity receipt per Jamat session (`identities/<sessionId>.json`) binding this launch
 *    generation to the real Antigravity conversation ID for Reopen and transcript readers.
 * 2. A context snapshot per conversation (`snapshots/<conversationId>.json`) carrying the active
 *    model label, context window size and transcript path for `SessionModelReader`.
 *
 * When the user already configured an enabled custom `statusLine` in `~/.gemini/antigravity-cli/settings.json`,
 * the relay passes stdin through (`--pass | <own.command>`) and preserves their layout options.
 *
 * Best effort throughout: a failure is reported once and costs the snapshot/identity, never the launch.
 */
export class AntigravityStatusLine {
  static readonly relaySourceConst = `'use strict'
const fs = require('node:fs')
const path = require('node:path')
const [directory, identities, ...flags] = process.argv.slice(2)
const option = (name) => { const at = flags.indexOf(name); return at < 0 ? null : flags[at + 1] }
const isId = (value) => typeof value === 'string' && /^[0-9A-Za-z-]{1,64}$/.test(value)
const session = option('--session')
const launch = option('--launch')
const write = (file, value) => {
  const temporary = file + '.' + process.pid + '.tmp'
  try {
    fs.writeFileSync(temporary, JSON.stringify(value))
    fs.renameSync(temporary, file)
  }
  finally {
    try { fs.unlinkSync(temporary) } catch {}
  }
}
const chunks = []
process.stdin.on('data', (chunk) => chunks.push(chunk)).on('end', () => {
  const text = Buffer.concat(chunks).toString('utf8')
  if (flags.includes('--pass')) process.stdout.write(text)
  let input
  try { input = JSON.parse(text) } catch { return }
  if (!input || typeof input !== 'object') return
  try {
    const email = typeof input.email === 'string' && input.email.trim().length > 0 ? input.email.trim() : null
    const planTier = typeof input.plan_tier === 'string' && input.plan_tier.trim().length > 0 ? input.plan_tier.trim() : null
    if (email !== null || planTier !== null) {
      const accountFile = path.join(path.dirname(identities), 'antigravity-account.json')
      let previous = null
      try { previous = JSON.parse(fs.readFileSync(accountFile, 'utf8')) } catch {}
      const next = {
        schemaVersion: 1,
        ...(email === null ? (previous && typeof previous.email === 'string' ? { email: previous.email } : {}) : { email }),
        ...(planTier === null ? (previous && typeof previous.planTier === 'string' ? { planTier: previous.planTier } : {}) : { planTier }),
      }
      if (!previous || previous.email !== next.email || previous.planTier !== next.planTier) {
        fs.mkdirSync(path.dirname(accountFile), { recursive: true })
        write(accountFile, next)
      }
    }
  }
  catch {}
  try {
    const quota = input.quota
    if (isId(session) && isId(launch) && quota && typeof quota === 'object' && !Array.isArray(quota) && Object.keys(quota).length > 0) {
      const rates = path.join(path.dirname(identities), 'rates')
      fs.mkdirSync(rates, { recursive: true })
      const planTier = typeof input.plan_tier === 'string' && input.plan_tier.length > 0 ? input.plan_tier : null
      write(path.join(rates, session + '.json'), {
        schemaVersion: 1,
        at: Date.now(),
        launchId: launch,
        antigravityQuota: quota,
        ...(planTier === null ? {} : { planTier }),
      })
    }
  }
  catch {}
  try {
    const modelObj = input.model && typeof input.model === 'object' ? input.model : null
    const model = modelObj && typeof modelObj.id === 'string' && modelObj.id.length > 0 ? modelObj.id : null
    const displayName = modelObj && typeof modelObj.display_name === 'string' && modelObj.display_name.length > 0
      ? modelObj.display_name : null
    const effort = modelObj && typeof modelObj.effort === 'string' && modelObj.effort.length > 0
      ? modelObj.effort : null
    const cw = input.context_window && typeof input.context_window === 'object' ? input.context_window : null
    const size = cw && Number.isSafeInteger(cw.context_window_size) && cw.context_window_size > 0
      ? cw.context_window_size : null
    const usedPercentage = cw && typeof cw.used_percentage === 'number' && Number.isFinite(cw.used_percentage)
      ? cw.used_percentage : null
    const transcriptPath = typeof input.transcript_path === 'string' && input.transcript_path.length > 0
      ? input.transcript_path : null
    const agentState = typeof input.agent_state === 'string' && input.agent_state.length > 0 ? input.agent_state : null
    const toolConfirmationPending = input.tool_confirmation_pending === true
    const taskCount = Number.isSafeInteger(input.task_count) && input.task_count > 0 ? input.task_count : 0
    const runningSubagents = Array.isArray(input.subagents)
      ? input.subagents.filter((item) => item && typeof item === 'object' && item.status === 'running').length
      : 0
    if (isId(session) && isId(launch) && (model !== null || displayName !== null || size !== null || agentState !== null || toolConfirmationPending || taskCount > 0 || runningSubagents > 0)) {
      fs.mkdirSync(directory, { recursive: true })
      write(path.join(directory, 'session-' + session + '.json'), {
        schemaVersion: 1,
        launchId: launch,
        updatedAt: Date.now(),
        ...(model === null ? {} : { model }),
        ...(displayName === null ? {} : { displayName }),
        ...(effort === null ? {} : { effort }),
        ...(size === null ? {} : { contextWindowSize: size }),
        ...(usedPercentage === null ? {} : { usedPercentage }),
        ...(agentState === null ? {} : { agentState }),
        ...(toolConfirmationPending ? { toolConfirmationPending: true } : {}),
        ...(taskCount > 0 ? { taskCount } : {}),
        ...(runningSubagents > 0 ? { runningSubagents } : {}),
        ...(transcriptPath === null ? {} : { transcriptPath }),
      })
    }
  }
  catch {}
  const rawId = typeof input.conversation_id === 'string' && input.conversation_id.length > 0
    ? input.conversation_id
    : input.session_id
  if (!isId(rawId)) return
  if (isId(session) && isId(launch)) try {
    const file = path.join(identities, session + '.json')
    let previous = null
    try { previous = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
    const same = previous !== null && typeof previous === 'object' && previous.launchId === launch
    if (!same || previous.nativeSessionId !== rawId) {
      fs.mkdirSync(identities, { recursive: true })
      const sequence = same && Number.isSafeInteger(previous.sequence) ? Math.max(Date.now(), previous.sequence + 1) : Date.now()
      write(file, { schemaVersion: 1, jamatSessionId: session, launchId: launch, nativeSessionId: rawId, sequence })
    }
  }
  catch {}
  try {
    const modelObj = input.model && typeof input.model === 'object' ? input.model : null
    const model = modelObj && typeof modelObj.id === 'string' && modelObj.id.length > 0 ? modelObj.id : null
    const displayName = modelObj && typeof modelObj.display_name === 'string' && modelObj.display_name.length > 0
      ? modelObj.display_name : null
    const effort = modelObj && typeof modelObj.effort === 'string' && modelObj.effort.length > 0
      ? modelObj.effort : null
    const cw = input.context_window && typeof input.context_window === 'object' ? input.context_window : null
    const size = cw && Number.isSafeInteger(cw.context_window_size) && cw.context_window_size > 0
      ? cw.context_window_size : null
    const usedPercentage = cw && typeof cw.used_percentage === 'number' && Number.isFinite(cw.used_percentage)
      ? cw.used_percentage : null
    const transcriptPath = typeof input.transcript_path === 'string' && input.transcript_path.length > 0
      ? input.transcript_path : null
    if (model === null && displayName === null && size === null && transcriptPath === null) return
    fs.mkdirSync(directory, { recursive: true })
    write(path.join(directory, rawId + '.json'), {
      schemaVersion: 1,
      ...(model === null ? {} : { model }),
      ...(displayName === null ? {} : { displayName }),
      ...(effort === null ? {} : { effort }),
      ...(size === null ? {} : { contextWindowSize: size }),
      ...(usedPercentage === null ? {} : { usedPercentage }),
      ...(transcriptPath === null ? {} : { transcriptPath }),
    })
  }
  catch {}
})
`

  private static readonly unsafeCommandCharactersConst = /[\s"'`$&|;<>()%!^]/
  private static readonly unsafeWrapperCharactersConst = /["%\r\n]/
  private static readonly idPatternConst = /^[0-9A-Za-z-]{1,64}$/

  private readonly directory: string
  private readonly snapshots: string
  private readonly identities: string
  private readonly antigravityHome: string
  private readonly tools: Pick<RunTools, 'node'>
  private readonly platform: NodeJS.Platform
  private readonly report: (message: string) => void
  private readonly reported = new Set<string>()
  private readonly receipts = new IdentityReceiptFile()

  constructor(options: {
    directory: string
    snapshots: string
    identities: string
    antigravityHome: string
    tools: Pick<RunTools, 'node'>
    report: (message: string) => void
    platform?: NodeJS.Platform
  }) {
    this.directory = options.directory
    this.snapshots = options.snapshots
    this.identities = options.identities
    this.antigravityHome = options.antigravityHome
    this.tools = options.tools
    this.report = options.report
    this.platform = options.platform ?? process.platform
  }

  /**
   * The `--settings` file for an Antigravity session, or null when the relay cannot be installed.
   */
  settingsFileFor(identity?: { sessionId: string; launchId: string }): string | null {
    try {
      const bad = identity === undefined ? undefined : [identity.sessionId, identity.launchId].find((id) => !AntigravityStatusLine.idPatternConst.test(id))
      if (bad !== undefined) {
        this.reportOnce(`identity:${bad}`, `Antigravity status line relay not installed: an identity that is not an id: ${JSON.stringify(bad)}`)
        return null
      }
      const relay = this.relayCommand()
      if (relay === null) return null
      const command = identity === undefined ? relay : `${relay} --session ${identity.sessionId} --launch ${identity.launchId}`
      const own = this.ownStatusLine()
      const statusLine = own === null
        ? { type: 'command', command, enabled: true, padding: 0, stack_with_default: true }
        : { ...own, type: 'command', enabled: true, command: `${command} --pass | ${own.command}` }
      const text = JSON.stringify({ statusLine })
      const file = join(this.directory, identity === undefined
        ? `settings-${createHash('sha256').update(text).digest('hex').slice(0, 16)}.json` : `settings-${identity.sessionId}.json`)
      AntigravityStatusLine.writeIfChanged(file, text)
      return file
    }
    catch (error) {
      this.reportOnce('failed', `Antigravity status line relay not installed: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  async identity(sessionId: string, launchId: string): Promise<{ nativeSessionId: string; sequence: number } | null> {
    if (!AntigravityStatusLine.idPatternConst.test(sessionId)) return null
    const file = join(this.identities, `${sessionId}.json`)
    try {
      const receipt = await this.receipts.read(file) as Record<string, unknown> | null
      if (receipt === null) return null
      const nativeSessionId = receipt['nativeSessionId']
      const sequence = receipt['sequence']
      if (receipt['schemaVersion'] !== 1 || receipt['jamatSessionId'] !== sessionId || typeof receipt['launchId'] !== 'string'
        || typeof nativeSessionId !== 'string' || !AntigravityStatusLine.idPatternConst.test(nativeSessionId)
        || typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 1)
        throw new Error('Identity receipt does not match this Antigravity session')
      return receipt['launchId'] === launchId ? { nativeSessionId, sequence } : null
    }
    catch (error) {
      this.reportOnce(`receipt:${sessionId}`, `Session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  /**
   * Reads the latest per-session live status written by the relay (`session-<sessionId>.json`).
   * Returns null when absent, malformed, or belonging to a different launch generation.
   */
  static async readSessionStatus(
    snapshotsDirectory: string,
    sessionId: string,
    launchId: string,
  ): Promise<AntigravitySessionStatus | null> {
    if (!AntigravityStatusLine.idPatternConst.test(sessionId) || !AntigravityStatusLine.idPatternConst.test(launchId))
      return null
    const file = join(snapshotsDirectory, `session-${sessionId}.json`)
    let parsed: unknown
    try { parsed = JSON.parse(await readFile(file, 'utf8')) }
    catch { return null }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const row = parsed as Record<string, unknown>
    if (row['schemaVersion'] !== 1 || row['launchId'] !== launchId) return null
    const updatedAt = typeof row['updatedAt'] === 'number' && Number.isFinite(row['updatedAt']) ? row['updatedAt'] : null
    if (updatedAt === null) return null
    const agentState = typeof row['agentState'] === 'string' && row['agentState'].length > 0 ? row['agentState'] : null
    const toolConfirmationPending = row['toolConfirmationPending'] === true
    const taskCount = typeof row['taskCount'] === 'number' && Number.isSafeInteger(row['taskCount']) && row['taskCount'] > 0
      ? row['taskCount'] : 0
    const runningSubagents = typeof row['runningSubagents'] === 'number' && Number.isSafeInteger(row['runningSubagents']) && row['runningSubagents'] > 0
      ? row['runningSubagents'] : 0
    if (agentState === null && !toolConfirmationPending && taskCount === 0 && runningSubagents === 0) return null
    return { launchId, updatedAt, agentState, toolConfirmationPending, taskCount, runningSubagents }
  }

  private relayCommand(): string | null {
    const node = this.tools.node()
    if (!node.ok) {
      this.reportOnce('node', `Antigravity status line relay not installed: ${node.detail}`)
      return null
    }
    mkdirSync(this.directory, { recursive: true })
    const script = join(this.directory, 'relay.cjs')
    AntigravityStatusLine.writeIfChanged(script, AntigravityStatusLine.relaySourceConst)
    if (this.platform === 'win32') {
      const wrapper = join(this.directory, 'relay.cmd')
      if ([node.command, script, this.snapshots, this.identities].some((value) => AntigravityStatusLine.unsafeWrapperCharactersConst.test(value))) {
        this.reportOnce('wrapper', `Antigravity status line relay not installed: a path holds a character cmd.exe would act on: ${this.snapshots}`)
        return null
      }
      AntigravityStatusLine.writeIfChanged(wrapper, `@"${node.command}" "${script}" "${this.snapshots}" "${this.identities}" %*\r\n`)
      const command = wrapper.replaceAll('\\', '/')
      if (AntigravityStatusLine.unsafeCommandCharactersConst.test(command)) {
        this.reportOnce('path', `Antigravity status line relay not installed: its path needs quoting: ${command}`)
        return null
      }
      return command
    }
    else if (this.platform === 'darwin' || this.platform === 'linux') {
      const wrapper = join(this.directory, 'relay.sh')
      AntigravityStatusLine.writeIfChanged(wrapper,
        `#!/bin/sh\nexec ${AntigravityStatusLine.singleQuoted(node.command)} ${AntigravityStatusLine.singleQuoted(script)} ${AntigravityStatusLine.singleQuoted(this.snapshots)} ${AntigravityStatusLine.singleQuoted(this.identities)} "$@"\n`,
        0o755)
      return AntigravityStatusLine.singleQuoted(wrapper)
    }
    else
      throw new Error(`Unsupported platform for the Antigravity status line relay: ${this.platform}`)
  }

  private ownStatusLine(): AntigravityStatusLineSetting | null {
    const file = join(this.antigravityHome, 'settings.json')
    let parsed: unknown
    try { parsed = JSON.parse(readFileSync(file, 'utf8')) }
    catch { return null }
    if (parsed === null || typeof parsed !== 'object') return null
    const statusLine = (parsed as Record<string, unknown>)['statusLine']
    if (statusLine === null || typeof statusLine !== 'object' || Array.isArray(statusLine)) return null
    const setting = statusLine as Record<string, unknown>
    if (setting['enabled'] === false) return null
    if (setting['type'] !== undefined && setting['type'] !== 'command') return null
    if (typeof setting['command'] !== 'string' || setting['command'].trim() === '') return null
    return setting as AntigravityStatusLineSetting
  }

  private reportOnce(key: string, message: string): void {
    if (this.reported.has(key)) return
    this.reported.add(key)
    this.report(message)
  }

  private static writeIfChanged(file: string, text: string, mode?: number): void {
    if (existsSync(file) && readFileSync(file, 'utf8') === text) return
    writeFileSync(file, text, mode === undefined ? 'utf8' : { encoding: 'utf8', mode })
  }

  private static singleQuoted(value: string): string {
    return `'${value.replaceAll("'", "'\\''")}'`
  }
}
