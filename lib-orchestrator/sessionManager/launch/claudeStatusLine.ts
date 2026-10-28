import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { RunTools } from './runTools'

/** What a Claude settings file says about the status line, as far as a relay has to repeat it. */
type ClaudeStatusLineSetting = Record<string, unknown> & { type: 'command'; command: string }

/**
 * The status line every interactive Claude session is started with, and the only way this client
 * learns the context window a session really runs on.
 *
 * Claude Code writes the bare model id into its transcript and never the tier, and which models
 * default to the million-token tier is the account's business, recorded in no file. Every guess built
 * from the id and the settings went stale with the next model (2026-09-09, -09-10, -09-25, -10-13).
 * The one place Claude Code states its own window is the JSON it pipes into a status line command:
 * `context_window.context_window_size`, the same number its auto-compact runs against (read off
 * Claude Code 2.1.296, where it is built beside `exceeds_200k_tokens` and `model.id`).
 *
 * So the launch adds `--settings <file>` with a status line that runs a relay: it stores that number
 * per Claude session id under `snapshots`, then prints nothing, or, when the person has a status line
 * of their own, hands it the same input through a pipe so what they see does not change. `--settings`
 * ranks above the user, project and local files and below managed policy, which then simply wins.
 *
 * **The command is one bare path.** On Windows Claude Code runs it under Git Bash when it finds one
 * and under PowerShell when it does not, and the two agree on a bare path and on `|`, but on no way
 * of quoting one: a quoted path is a string expression to PowerShell. A path that needs quoting is
 * refused, and the reader falls back to its table. Both shells were measured running the `.cmd`
 * wrapper with stdin and with a pipe after it.
 *
 * **It is also the one witness of which conversation Claude really runs.** Claude Code 2.1.304 was
 * started with `--session-id` and wrote its conversation under another id, which its status line
 * input named as `session_id` (UA1-J14-1). So a launch hands the relay its Jamat session id and its
 * launch generation (`--session`, `--launch`), and the relay keeps one receipt per Jamat session
 * under `identities`: the generation and the conversation id Claude reported last. `identity` reads
 * it back for exactly that session and generation, the way a Codex bridge receipt is read; no
 * transcript, directory or time takes part.
 *
 * Best effort throughout: a failure costs the snapshot and is reported once, never the launch.
 */
export class ClaudeStatusLine {
  /**
   * The relay, run by Claude Code at every status line refresh. Plain CommonJS with no imports
   * beyond Node's own, because it is written out and run as it stands. It never fails the status
   * line: an input it cannot use is passed on and not stored. The session id becomes a file name,
   * so it must be an id and nothing that walks out of the folder.
   */
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
  const id = input && input.session_id
  if (!isId(id)) return
  if (isId(session) && isId(launch)) try {
    const file = path.join(identities, session + '.json')
    let previous = null
    try { previous = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
    const same = previous !== null && typeof previous === 'object' && previous.launchId === launch
    if (!same || previous.nativeSessionId !== id) {
      fs.mkdirSync(identities, { recursive: true })
      const sequence = same && Number.isSafeInteger(previous.sequence) ? Math.max(Date.now(), previous.sequence + 1) : Date.now()
      write(file, { schemaVersion: 1, jamatSessionId: session, launchId: launch, nativeSessionId: id, sequence })
    }
  }
  catch {}
  try {
    const limits = input.rate_limits
    const windows = limits && typeof limits === 'object' && !Array.isArray(limits)
      ? [limits.five_hour, limits.seven_day].filter(value => value !== undefined) : []
    if (isId(session) && isId(launch) && windows.length > 0 && windows.every(value => value && typeof value === 'object'
      && Number.isFinite(value.used_percentage) && Number.isFinite(value.resets_at))) {
      const rates = path.join(path.dirname(identities), 'rates')
      fs.mkdirSync(rates, { recursive: true })
      write(path.join(rates, session + '.json'), { schemaVersion: 1, at: Date.now(), launchId: launch, rateLimits: limits })
    }
  }
  catch {}
  try {
    const model = input.model && input.model.id
    const size = input.context_window && input.context_window.context_window_size
    if (typeof model !== 'string' || !Number.isSafeInteger(size) || size <= 0) return
    fs.mkdirSync(directory, { recursive: true })
    write(path.join(directory, id + '.json'), { schemaVersion: 1, model, contextWindowSize: size })
  }
  catch {}
})
`

  private static readonly unsafeCommandCharactersConst = /[\s"'`$&|;<>()%!^]/
  private static readonly unsafeWrapperCharactersConst = /["%\r\n]/
  /** A session or conversation id: it becomes a file name and a word of the status line command. */
  private static readonly idPatternConst = /^[0-9A-Za-z-]{1,64}$/
  /** A receipt is a few hundred bytes; a larger file is not one. */
  private static readonly receiptBytesConst = 8192

  private readonly directory: string
  private readonly snapshots: string
  private readonly identities: string
  private readonly claudeHome: string
  private readonly tools: Pick<RunTools, 'node'>
  private readonly platform: NodeJS.Platform
  private readonly report: (message: string) => void
  private readonly reported = new Set<string>()

  constructor(options: {
    directory: string
    snapshots: string
    /** Where the relay keeps one identity receipt per Jamat session. */
    identities: string
    claudeHome: string
    tools: Pick<RunTools, 'node'>
    report: (message: string) => void
    platform?: NodeJS.Platform
  }) {
    this.directory = options.directory
    this.snapshots = options.snapshots
    this.identities = options.identities
    this.claudeHome = options.claudeHome
    this.tools = options.tools
    this.report = options.report
    this.platform = options.platform ?? process.platform
  }

  /**
   * The `--settings` file for a Claude session started in `cwd`, or null when there is none to give.
   * With `identity`, the relay reports the conversation of that Jamat session and launch generation,
   * and the file is that session's own, rewritten at each launch.
   */
  settingsFileFor(cwd: string, identity?: { sessionId: string; launchId: string }): string | null {
    try {
      const bad = identity === undefined ? undefined : [identity.sessionId, identity.launchId].find((id) => !ClaudeStatusLine.idPatternConst.test(id))
      if (bad !== undefined) {
        this.reportOnce(`identity:${bad}`, `Claude status line relay not installed: an identity that is not an id: ${JSON.stringify(bad)}`)
        return null
      }
      const relay = this.relayCommand()
      if (relay === null) return null
      const command = identity === undefined ? relay : `${relay} --session ${identity.sessionId} --launch ${identity.launchId}`
      const own = this.ownStatusLine(cwd)
      const statusLine = own === null
        ? { type: 'command', command }
        // `|` binds tighter than `&&` and `||` in both shells, so an own command chained with those
        // hands only its first step our input; Claude Code would have handed it to the whole line.
        : { ...own, command: `${command} --pass | ${own.command}` }
      const text = JSON.stringify({ statusLine })
      const file = join(this.directory, identity === undefined
        ? `settings-${createHash('sha256').update(text).digest('hex').slice(0, 16)}.json` : `settings-${identity.sessionId}.json`)
      ClaudeStatusLine.writeIfChanged(file, text)
      return file
    }
    catch (error) {
      this.reportOnce('failed', `Claude status line relay not installed: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  /**
   * The conversation the relay last saw Claude run for this Jamat session in this launch generation,
   * or null: no receipt yet, a receipt of another generation, or one that is malformed (reported once).
   */
  identity(sessionId: string, launchId: string): { nativeSessionId: string; sequence: number } | null {
    if (!ClaudeStatusLine.idPatternConst.test(sessionId)) return null
    const file = join(this.identities, `${sessionId}.json`)
    try {
      if (!existsSync(file)) return null
      if (statSync(file).size > ClaudeStatusLine.receiptBytesConst) throw new Error('Identity receipt exceeds 8 KiB')
      const receipt = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> | null
      const nativeSessionId = receipt?.['nativeSessionId']
      const sequence = receipt?.['sequence']
      if (receipt?.['schemaVersion'] !== 1 || receipt['jamatSessionId'] !== sessionId || typeof receipt['launchId'] !== 'string'
        || typeof nativeSessionId !== 'string' || !ClaudeStatusLine.idPatternConst.test(nativeSessionId)
        || typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 1)
        throw new Error('Identity receipt does not match this Claude session')
      return receipt['launchId'] === launchId ? { nativeSessionId, sequence } : null
    }
    catch (error) {
      this.reportOnce(`receipt:${sessionId}`, `Session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  /** The bare command that runs the relay, written to disk first; null when this machine has none. */
  private relayCommand(): string | null {
    const node = this.tools.node()
    if (!node.ok) {
      this.reportOnce('node', `Claude status line relay not installed: ${node.detail}`)
      return null
    }
    mkdirSync(this.directory, { recursive: true })
    const script = join(this.directory, 'relay.cjs')
    ClaudeStatusLine.writeIfChanged(script, ClaudeStatusLine.relaySourceConst)
    if (this.platform === 'win32') {
      const wrapper = join(this.directory, 'relay.cmd')
      if ([node.command, script, this.snapshots, this.identities].some((value) => ClaudeStatusLine.unsafeWrapperCharactersConst.test(value))) {
        this.reportOnce('wrapper', `Claude status line relay not installed: a path holds a character cmd.exe would act on: ${this.snapshots}`)
        return null
      }
      ClaudeStatusLine.writeIfChanged(wrapper, `@"${node.command}" "${script}" "${this.snapshots}" "${this.identities}" %*\r\n`)
      // Forward slashes: Git Bash reads a bare backslash as an escape, PowerShell takes either.
      const command = wrapper.replaceAll('\\', '/')
      if (ClaudeStatusLine.unsafeCommandCharactersConst.test(command)) {
        this.reportOnce('path', `Claude status line relay not installed: its path needs quoting, which Git Bash and PowerShell read differently: ${command}`)
        return null
      }
      return command
    }
    else if (this.platform === 'darwin' || this.platform === 'linux') {
      const wrapper = join(this.directory, 'relay.sh')
      ClaudeStatusLine.writeIfChanged(wrapper,
        `#!/bin/sh\nexec ${ClaudeStatusLine.singleQuoted(node.command)} ${ClaudeStatusLine.singleQuoted(script)} ${ClaudeStatusLine.singleQuoted(this.snapshots)} ${ClaudeStatusLine.singleQuoted(this.identities)} "$@"\n`,
        0o755)
      return ClaudeStatusLine.singleQuoted(wrapper)
    }
    else
      throw new Error(`Unsupported platform for the Claude status line relay: ${this.platform}`)
  }

  /** The status line the person configured, in Claude Code's own precedence, or null. */
  private ownStatusLine(cwd: string): ClaudeStatusLineSetting | null {
    for (const file of [
      join(cwd, '.claude', 'settings.local.json'),
      join(cwd, '.claude', 'settings.json'),
      join(this.claudeHome, 'settings.json'),
    ]) {
      let parsed: unknown
      try { parsed = JSON.parse(readFileSync(file, 'utf8')) }
      catch { continue }
      if (parsed === null || typeof parsed !== 'object') continue
      const statusLine = (parsed as Record<string, unknown>)['statusLine']
      if (statusLine === null || typeof statusLine !== 'object') continue
      const setting = statusLine as Record<string, unknown>
      if (setting['type'] === 'command' && typeof setting['command'] === 'string' && setting['command'].trim() !== '')
        return setting as ClaudeStatusLineSetting
    }
    return null
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
