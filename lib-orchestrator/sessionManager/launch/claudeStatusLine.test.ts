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
        identities: join(root, 'claude-identity'),
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
      `@"${process.execPath}" "${join(root, 'claude-statusline', 'relay.cjs')}" "${join(root, 'claude-context')}" "${join(root, 'claude-identity')}" %*\r\n`)
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

  // Claude Code 2.1.304 was started with --session-id and wrote its conversation under another id;
  // the relay is the one place that reports the id Claude really runs (UA1-J14-1).
  it('hands the relay the Jamat session and its launch generation, one settings file per session', () => {
    const { root, cwd, home, relay } = world()
    const statusLine = relay('win32')
    const file = statusLine.settingsFileFor(cwd, { sessionId: 'jamat-1', launchId: 'launch-1' })
    const wrapper = join(root, 'claude-statusline', 'relay.cmd').replaceAll('\\', '/')
    expect(settingsOf(file).statusLine['command']).toBe(`${wrapper} --session jamat-1 --launch launch-1`)
    expect(file).toBe(join(root, 'claude-statusline', 'settings-jamat-1.json'))
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'mine' } }))
    expect(settingsOf(statusLine.settingsFileFor(cwd, { sessionId: 'jamat-1', launchId: 'launch-2' })).statusLine['command'])
      .toBe(`${wrapper} --session jamat-1 --launch launch-2 --pass | mine`)
  })

  it('refuses a session or launch id that is not one, and says so once', () => {
    const { cwd, reports, relay } = world()
    const statusLine = relay('win32')
    expect(statusLine.settingsFileFor(cwd, { sessionId: 'a b', launchId: 'l' })).toBeNull()
    expect(reports).toEqual(['Claude status line relay not installed: an identity that is not an id: "a b"'])
  })

  it('reads back only the receipt of the asked session and launch', () => {
    const { root, reports, relay } = world()
    const statusLine = relay('win32')
    mkdirSync(join(root, 'claude-identity'))
    const receipt = { schemaVersion: 1, jamatSessionId: 'jamat-1', launchId: 'launch-1', nativeSessionId: '11126908-45f3-438e-b263-6138206cd005', sequence: 7 }
    writeFileSync(join(root, 'claude-identity', 'jamat-1.json'), JSON.stringify(receipt))
    expect(statusLine.identity('jamat-1', 'launch-1')).toEqual({ nativeSessionId: receipt.nativeSessionId, sequence: 7 })
    expect(statusLine.identity('jamat-1', 'launch-2')).toBeNull()
    expect(statusLine.identity('jamat-2', 'launch-1')).toBeNull()
    expect(reports).toEqual([])
    writeFileSync(join(root, 'claude-identity', 'jamat-1.json'), JSON.stringify({ ...receipt, jamatSessionId: 'jamat-2' }))
    expect(statusLine.identity('jamat-1', 'launch-1')).toBeNull()
    expect(statusLine.identity('jamat-1', 'launch-1')).toBeNull()
    expect(reports).toHaveLength(1)
  })

  it('writes an executable shell wrapper on POSIX and single-quotes its path', () => {
    const { root, cwd, relay } = world()
    const { statusLine } = settingsOf(relay('linux').settingsFileFor(cwd))
    expect(statusLine['command']).toBe(`'${join(root, 'claude-statusline', 'relay.sh')}'`)
    expect(readFileSync(join(root, 'claude-statusline', 'relay.sh'), 'utf8')).toMatch(/^#!\/bin\/sh\nexec '/)
  })

  describe('the relay itself', () => {
    function run(root: string, input: string, mode?: string, flags: readonly string[] = []): { stdout: string; status: number | null } {
      const script = join(root, 'relay.cjs')
      writeFileSync(script, ClaudeStatusLine.relaySourceConst)
      const result = spawnSync(process.execPath, [script, join(root, 'snapshots'), join(root, 'identities'), ...flags, ...(mode ? [mode] : [])],
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

    function receiptOf(root: string, sessionId: string): Record<string, unknown> {
      return JSON.parse(readFileSync(join(root, 'identities', `${sessionId}.json`), 'utf8'))
    }

    it('reports the conversation Claude runs for the Jamat session and launch it was given, and its later changes', () => {
      const { root } = world()
      const flags = ['--session', 'jamat-1', '--launch', 'launch-1']
      expect(run(root, input, '--pass', flags)).toEqual({ stdout: input, status: 0 })
      const first = receiptOf(root, 'jamat-1')
      expect(first).toMatchObject({ schemaVersion: 1, jamatSessionId: 'jamat-1', launchId: 'launch-1', nativeSessionId: '44e51484-ec6d-420e-afce-d0d621d9f40b' })
      expect(Number.isSafeInteger(first['sequence'])).toBe(true)
      run(root, input, undefined, flags)
      expect(receiptOf(root, 'jamat-1')).toEqual(first)
      const moved = input.replace('44e51484-ec6d-420e-afce-d0d621d9f40b', '11126908-45f3-438e-b263-6138206cd005')
      run(root, moved, undefined, flags)
      const second = receiptOf(root, 'jamat-1')
      expect(second['nativeSessionId']).toBe('11126908-45f3-438e-b263-6138206cd005')
      expect(second['sequence'] as number).toBeGreaterThan(first['sequence'] as number)
    })

    it('reports no conversation without a Jamat session, or for one that is not an id', () => {
      const { root } = world()
      run(root, input, '--pass')
      run(root, input, '--pass', ['--session', '../x', '--launch', 'launch-1'])
      expect(existsSync(join(root, 'identities'))).toBe(false)
    })

    it('writes valid installed-CLI rates and leaves them untouched for missing or malformed rates', () => {
      const { root } = world()
      const flags = ['--session', 'jamat-1', '--launch', 'launch-1']
      const limits = { five_hour: { used_percentage: 37, resets_at: 1793115673 }, seven_day: { used_percentage: 21, resets_at: 1793702473 } }
      const withRates = JSON.stringify({ ...JSON.parse(input), rate_limits: limits })
      expect(run(root, withRates, '--pass', flags)).toEqual({ stdout: withRates, status: 0 })
      const file = join(root, 'rates', 'jamat-1.json')
      const stored = readFileSync(file, 'utf8')
      expect(JSON.parse(stored)).toMatchObject({ schemaVersion: 1, launchId: 'launch-1', rateLimits: limits })
      expect(Number.isFinite(JSON.parse(stored).at)).toBe(true)
      for (const rate_limits of [undefined, [], 'bad', { five_hour: { used_percentage: 'bad' } }]) {
        const missing = JSON.stringify({ ...JSON.parse(input), rate_limits })
        expect(run(root, missing, '--pass', flags)).toEqual({ stdout: missing, status: 0 })
        expect(readFileSync(file, 'utf8')).toBe(stored)
      }
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
