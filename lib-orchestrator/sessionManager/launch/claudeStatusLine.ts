import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
const [directory, mode] = process.argv.slice(2)
const chunks = []
process.stdin.on('data', (chunk) => chunks.push(chunk)).on('end', () => {
  const text = Buffer.concat(chunks).toString('utf8')
  if (mode === '--pass') process.stdout.write(text)
  let temporary = null
  try {
    const input = JSON.parse(text)
    const id = input.session_id
    const model = input.model && input.model.id
    const size = input.context_window && input.context_window.context_window_size
    if (typeof id !== 'string' || !/^[0-9A-Za-z-]{1,64}$/.test(id)) return
    if (typeof model !== 'string' || !Number.isSafeInteger(size) || size <= 0) return
    fs.mkdirSync(directory, { recursive: true })
    const file = path.join(directory, id + '.json')
    temporary = file + '.' + process.pid + '.tmp'
    fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, model, contextWindowSize: size }))
    fs.renameSync(temporary, file)
    temporary = null
  }
  catch {}
  finally {
    if (temporary !== null) try { fs.unlinkSync(temporary) } catch {}
  }
})
`

  private static readonly unsafeCommandCharactersConst = /[\s"'`$&|;<>()%!^]/
  private static readonly unsafeWrapperCharactersConst = /["%\r\n]/

  private readonly directory: string
  private readonly snapshots: string
  private readonly claudeHome: string
  private readonly tools: Pick<RunTools, 'node'>
  private readonly platform: NodeJS.Platform
  private readonly report: (message: string) => void
  private readonly reported = new Set<string>()

  constructor(options: {
    directory: string
    snapshots: string
    claudeHome: string
    tools: Pick<RunTools, 'node'>
    report: (message: string) => void
    platform?: NodeJS.Platform
  }) {
    this.directory = options.directory
    this.snapshots = options.snapshots
    this.claudeHome = options.claudeHome
    this.tools = options.tools
    this.report = options.report
    this.platform = options.platform ?? process.platform
  }

  /** The `--settings` file for a Claude session started in `cwd`, or null when there is none to give. */
  settingsFileFor(cwd: string): string | null {
    try {
      const command = this.relayCommand()
      if (command === null) return null
      const own = this.ownStatusLine(cwd)
      const statusLine = own === null
        ? { type: 'command', command }
        // `|` binds tighter than `&&` and `||` in both shells, so an own command chained with those
        // hands only its first step our input; Claude Code would have handed it to the whole line.
        : { ...own, command: `${command} --pass | ${own.command}` }
      const text = JSON.stringify({ statusLine })
      const file = join(this.directory, `settings-${createHash('sha256').update(text).digest('hex').slice(0, 16)}.json`)
      ClaudeStatusLine.writeIfChanged(file, text)
      return file
    }
    catch (error) {
      this.reportOnce('failed', `Claude status line relay not installed: ${error instanceof Error ? error.message : String(error)}`)
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
      if ([node.command, script, this.snapshots].some((value) => ClaudeStatusLine.unsafeWrapperCharactersConst.test(value))) {
        this.reportOnce('wrapper', `Claude status line relay not installed: a path holds a character cmd.exe would act on: ${this.snapshots}`)
        return null
      }
      ClaudeStatusLine.writeIfChanged(wrapper, `@"${node.command}" "${script}" "${this.snapshots}" %*\r\n`)
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
        `#!/bin/sh\nexec ${ClaudeStatusLine.singleQuoted(node.command)} ${ClaudeStatusLine.singleQuoted(script)} ${ClaudeStatusLine.singleQuoted(this.snapshots)} "$@"\n`,
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
