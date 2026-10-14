import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ClaudeStatusLine } from './claudeStatusLine'

describe('lib-orchestrator/sessionManager/launch/claudeStatusLine', () => {
  const roots: string[] = []
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

  function world(name = 'jamat-v3-statusline-') {
    const root = mkdtempSync(join(tmpdir(), name))
    roots.push(root)
    const cwd = join(root, 'project')
    const home = join(root, 'home')
    mkdirSync(cwd)
    mkdirSync(home)
    const reports: string[] = []
    const relay = (platform: NodeJS.Platform, hasNode = true) =>
      new ClaudeStatusLine({
        directory: join(root, 'claude-statusline'),
        snapshots: join(root, 'claude-context'),
        claudeHome: home,
        tools: { node: () => hasNode ? { ok: true, command: process.execPath } : { ok: false, detail: 'no node here' } },
        report: (message) => reports.push(message),
        platform,
      })
    return { root, cwd, home, reports, relay }
  }

  function settingsOf(file: string | null): { statusLine: Record<string, unknown> } {
    if (file === null) throw new Error('no settings file')
    return JSON.parse(readFileSync(file, 'utf8'))
  }

  it('names the relay as one bare forward-slash path and writes what it runs', () => {
    const { root, cwd, relay } = world()
    const file = relay('win32').settingsFileFor(cwd)
    const wrapper = join(root, 'claude-statusline', 'relay.cmd')
    expect(settingsOf(file)).toEqual({ statusLine: { type: 'command', command: wrapper.replaceAll('\\', '/') } })
    expect(readFileSync(wrapper, 'utf8')).toBe(
      `@"${process.execPath}" "${join(root, 'claude-statusline', 'relay.cjs')}" "${join(root, 'claude-context')}" %*\r\n`)
    expect(readFileSync(join(root, 'claude-statusline', 'relay.cjs'), 'utf8')).toBe(ClaudeStatusLine.relaySourceConst)
  })

  // A person's own status line must look exactly as before: it gets the same input through a pipe
  // and keeps its other settings. The most specific file wins, as in Claude Code.
  it('pipes into the status line the person configured, keeping its settings', () => {
    const { cwd, home, relay } = world()
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: '~/.claude/home.sh' } }))
    mkdirSync(join(cwd, '.claude'))
    writeFileSync(join(cwd, '.claude', 'settings.local.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'node ./line.js', padding: 2 } }))
    const { statusLine } = settingsOf(relay('win32').settingsFileFor(cwd))
    expect(statusLine).toMatchObject({ type: 'command', padding: 2 })
    expect(statusLine['command']).toMatch(/\/relay\.cmd --pass \| node \.\/line\.js$/)
  })

  it('names one settings file per content, so a second launch reuses it', () => {
    const { cwd, home, relay } = world()
    const statusLine = relay('win32')
    const first = statusLine.settingsFileFor(cwd)
    expect(statusLine.settingsFileFor(cwd)).toBe(first)
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'mine' } }))
    expect(statusLine.settingsFileFor(cwd)).not.toBe(first)
  })

  // Git Bash and PowerShell agree on no way of quoting a path, so a path that needs it is refused.
  it('refuses a relay path that would need quoting, and says so once', () => {
    const { cwd, reports, relay } = world('jamat v3 statusline ')
    const statusLine = relay('win32')
    expect(statusLine.settingsFileFor(cwd)).toBeNull()
    expect(statusLine.settingsFileFor(cwd)).toBeNull()
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatch(/needs quoting/)
  })

  it('answers null and reports once when there is no Node runtime', () => {
    const { cwd, reports, relay } = world()
    const statusLine = relay('win32', false)
    expect(statusLine.settingsFileFor(cwd)).toBeNull()
    expect(statusLine.settingsFileFor(cwd)).toBeNull()
    expect(reports).toEqual(['Claude status line relay not installed: no node here'])
  })

  it('writes an executable shell wrapper on POSIX and single-quotes its path', () => {
    const { root, cwd, relay } = world()
    const { statusLine } = settingsOf(relay('linux').settingsFileFor(cwd))
    expect(statusLine['command']).toBe(`'${join(root, 'claude-statusline', 'relay.sh')}'`)
    expect(readFileSync(join(root, 'claude-statusline', 'relay.sh'), 'utf8')).toMatch(/^#!\/bin\/sh\nexec '/)
  })

  describe('the relay itself', () => {
    function run(root: string, input: string, mode?: string): { stdout: string; status: number | null } {
      const script = join(root, 'relay.cjs')
      writeFileSync(script, ClaudeStatusLine.relaySourceConst)
      const result = spawnSync(process.execPath, [script, join(root, 'snapshots'), ...(mode ? [mode] : [])],
        { input, encoding: 'utf8' })
      return { stdout: result.stdout, status: result.status }
    }

    const input = JSON.stringify({
      session_id: '44e51484-ec6d-420e-afce-d0d621d9f40b',
      model: { id: 'claude-fable-5-1', display_name: 'Fable 5.1' },
      context_window: { context_window_size: 1_000_000, total_input_tokens: 91_000 },
    })

    it('stores the window under the session id and prints nothing', () => {
      const { root } = world()
      expect(run(root, input)).toEqual({ stdout: '', status: 0 })
      expect(JSON.parse(readFileSync(join(root, 'snapshots', '44e51484-ec6d-420e-afce-d0d621d9f40b.json'), 'utf8')))
        .toEqual({ schemaVersion: 1, model: 'claude-fable-5-1', contextWindowSize: 1_000_000 })
    })

    it('hands its input on unchanged in pass mode', () => {
      const { root } = world()
      expect(run(root, input, '--pass')).toEqual({ stdout: input, status: 0 })
    })

    it('stores nothing for a session id that is not one, and still passes the input on', () => {
      const { root } = world()
      const hostile = input.replace('44e51484-ec6d-420e-afce-d0d621d9f40b', '../../escape')
      expect(run(root, hostile, '--pass')).toEqual({ stdout: hostile, status: 0 })
      expect(run(root, 'not json', '--pass')).toEqual({ stdout: 'not json', status: 0 })
      expect(existsSync(join(root, 'snapshots'))).toBe(false)
    })
  })
})
