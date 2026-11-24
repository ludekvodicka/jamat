import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { AntigravityStatusLine } from './antigravityStatusLine'

describe('lib-orchestrator/sessionManager/launch/antigravityStatusLine', () => {
  const roots: string[] = []

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'jamat-agy-sl-'))
    roots.push(dir)
    return dir
  }

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('writes session settings with stack_with_default and records identity and context snapshots via relay', async () => {
    const root = tempDir()
    const directory = join(root, 'statusline')
    const snapshots = join(root, 'snapshots')
    const identities = join(root, 'identities')
    const antigravityHome = join(root, 'agy-home')
    const reported: string[] = []
    const relay = new AntigravityStatusLine({
      directory,
      snapshots,
      identities,
      antigravityHome,
      tools: { node: () => ({ ok: true, command: process.execPath }) },
      report: (message) => reported.push(message),
    })

    const settingsFile = relay.settingsFileFor({ sessionId: 'sess-1', launchId: 'launch-1' })
    expect(settingsFile).not.toBeNull()
    const settings = JSON.parse(readFileSync(settingsFile!, 'utf8')) as {
      statusLine: { type: string; command: string; enabled: boolean; stack_with_default: boolean }
    }
    expect(settings.statusLine.type).toBe('command')
    expect(settings.statusLine.enabled).toBe(true)
    expect(settings.statusLine.stack_with_default).toBe(true)
    expect(settings.statusLine.command).toContain('--session sess-1 --launch launch-1')

    const run = spawnSync(
      process.execPath,
      [join(directory, 'relay.cjs'), snapshots, identities, '--session', 'sess-1', '--launch', 'launch-1'],
      {
        input: JSON.stringify({
          conversation_id: 'conv-42',
          session_id: 'conv-42',
          model: { id: 'gemini-4-neon-high', display_name: 'Gemini 4 Neon' },
          context_window: { context_window_size: 1_000_000, used_percentage: 12.5 },
          transcript_path: 'C:\\brain\\conv-42\\transcript.jsonl',
        }),
        encoding: 'utf8',
      },
    )
    expect(run.status).toBe(0)
    expect(run.stdout).toBe('')

    const id = await relay.identity('sess-1', 'launch-1')
    expect(id).toMatchObject({ nativeSessionId: 'conv-42' })
    expect(await relay.identity('sess-1', 'other-launch')).toBeNull()

    const snapshot = JSON.parse(readFileSync(join(snapshots, 'conv-42.json'), 'utf8')) as Record<string, unknown>
    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      model: 'gemini-4-neon-high',
      displayName: 'Gemini 4 Neon',
      contextWindowSize: 1_000_000,
      usedPercentage: 12.5,
      transcriptPath: 'C:\\brain\\conv-42\\transcript.jsonl',
    })
    const sessionSnapshot = JSON.parse(readFileSync(join(snapshots, 'session-sess-1.json'), 'utf8')) as Record<string, unknown>
    expect(sessionSnapshot).toMatchObject({
      schemaVersion: 1,
      launchId: 'launch-1',
      model: 'gemini-4-neon-high',
      displayName: 'Gemini 4 Neon',
      contextWindowSize: 1_000_000,
      usedPercentage: 12.5,
    })
    expect(reported).toEqual([])
  })

  it('records quota into sibling rates/ even before conversation_id is assigned', () => {
    const root = tempDir()
    const directory = join(root, 'antigravity-statusline')
    const snapshots = join(root, 'antigravity-context')
    const identities = join(root, 'antigravity-identity')
    const relay = new AntigravityStatusLine({
      directory,
      snapshots,
      identities,
      antigravityHome: join(root, 'agy-home'),
      tools: { node: () => ({ ok: true, command: process.execPath }) },
      report: () => undefined,
    })

    expect(relay.settingsFileFor({ sessionId: 'sess-q', launchId: 'launch-q' })).not.toBeNull()
    const quota = {
      'gemini-5h': { remaining_fraction: 0.85, reset_in_seconds: 12_000 },
      'gemini-weekly': { remaining_fraction: 0.94, reset_time: '2026-11-28T00:00:00Z' },
    }
    const run = spawnSync(
      process.execPath,
      [join(directory, 'relay.cjs'), snapshots, identities, '--session', 'sess-q', '--launch', 'launch-q'],
      {
        input: JSON.stringify({
          conversation_id: '',
          session_id: '',
          email: 'dev@example.com',
          plan_tier: 'Pro',
          model: { id: 'gemini-4-neon-high', display_name: 'Gemini 4 Neon (High)', effort: 'high' },
          agent_state: 'idle',
          tool_confirmation_pending: false,
          quota,
        }),
        encoding: 'utf8',
      },
    )
    expect(run.status).toBe(0)
    const rate = JSON.parse(readFileSync(join(root, 'rates', 'sess-q.json'), 'utf8')) as Record<string, unknown>
    expect(rate).toMatchObject({
      schemaVersion: 1,
      launchId: 'launch-q',
      planTier: 'Pro',
      antigravityQuota: quota,
    })
    expect(typeof rate.at).toBe('number')
    expect(JSON.parse(readFileSync(join(root, 'antigravity-account.json'), 'utf8'))).toEqual({
      schemaVersion: 1,
      email: 'dev@example.com',
      planTier: 'Pro',
    })
    expect(JSON.parse(readFileSync(join(snapshots, 'session-sess-q.json'), 'utf8'))).toMatchObject({
      schemaVersion: 1,
      launchId: 'launch-q',
      model: 'gemini-4-neon-high',
      displayName: 'Gemini 4 Neon (High)',
      effort: 'high',
      agentState: 'idle',
    })
  })

  it('pipes through an existing user statusLine command when configured', () => {
    const root = tempDir()
    const antigravityHome = join(root, 'agy-home')
    mkdirSync(antigravityHome, { recursive: true })
    writeFileSync(join(antigravityHome, 'settings.json'), JSON.stringify({
      statusLine: { type: 'command', command: 'my-statusline --short', enabled: true, stack_with_default: false },
    }))
    const relay = new AntigravityStatusLine({
      directory: join(root, 'statusline'),
      snapshots: join(root, 'snapshots'),
      identities: join(root, 'identities'),
      antigravityHome,
      tools: { node: () => ({ ok: true, command: process.execPath }) },
      report: () => undefined,
    })

    const settingsFile = relay.settingsFileFor({ sessionId: 'sess-2', launchId: 'launch-2' })
    const settings = JSON.parse(readFileSync(settingsFile!, 'utf8')) as {
      statusLine: { command: string; stack_with_default: boolean }
    }
    expect(settings.statusLine.command).toContain('--pass | my-statusline --short')
    expect(settings.statusLine.stack_with_default).toBe(false)
  })

  it('records active background task_count and running subagents into session status snapshots', async () => {
    const root = tempDir()
    const directory = join(root, 'antigravity-statusline')
    const snapshots = join(root, 'antigravity-context')
    const identities = join(root, 'antigravity-identity')
    const relay = new AntigravityStatusLine({
      directory,
      snapshots,
      identities,
      antigravityHome: join(root, 'agy-home'),
      tools: { node: () => ({ ok: true, command: process.execPath }) },
      report: () => undefined,
    })

    expect(relay.settingsFileFor({ sessionId: 'sess-bg', launchId: 'launch-bg' })).not.toBeNull()
    const run = spawnSync(
      process.execPath,
      [join(directory, 'relay.cjs'), snapshots, identities, '--session', 'sess-bg', '--launch', 'launch-bg'],
      {
        input: JSON.stringify({
          conversation_id: 'conv-bg',
          agent_state: 'idle',
          tool_confirmation_pending: false,
          task_count: 2,
          subagents: [
            { name: 'research', role: 'Codebase Researcher', status: 'running' },
            { name: 'self', role: 'Done helper', status: 'completed' },
          ],
        }),
        encoding: 'utf8',
      },
    )
    expect(run.status).toBe(0)
    const status = await AntigravityStatusLine.readSessionStatus(snapshots, 'sess-bg', 'launch-bg')
    expect(status).toMatchObject({
      launchId: 'launch-bg',
      agentState: 'idle',
      toolConfirmationPending: false,
      taskCount: 2,
      runningSubagents: 1,
    })
  })

  it('merges trustedWorkspaces into the session settings file without modifying user settings.json', () => {
    const root = tempDir()
    const antigravityHome = join(root, 'agy-home')
    mkdirSync(antigravityHome, { recursive: true })
    const userSettingsFile = join(antigravityHome, 'settings.json')
    const userSettingsText = JSON.stringify({
      trustedWorkspaces: ['Q:\\Existing\\Workspace', 'Q:\\Work\\Tree'],
    })
    writeFileSync(userSettingsFile, userSettingsText)
    const relay = new AntigravityStatusLine({
      directory: join(root, 'statusline'),
      snapshots: join(root, 'snapshots'),
      identities: join(root, 'identities'),
      antigravityHome,
      tools: { node: () => ({ ok: true, command: process.execPath }) },
      report: () => undefined,
      platform: 'win32',
    })

    const gatedFile = relay.settingsFileFor({ sessionId: 'sess-gated', launchId: 'launch-1' })
    const gated = JSON.parse(readFileSync(gatedFile!, 'utf8')) as Record<string, unknown>
    expect(gated.statusLine).toBeDefined()
    expect(gated.trustedWorkspaces).toBeUndefined()

    const yoloFile = relay.settingsFileFor(
      { sessionId: 'sess-yolo', launchId: 'launch-1' },
      { trustedDirectory: 'Q:/Work/Tree/' },
    )
    const yolo = JSON.parse(readFileSync(yoloFile!, 'utf8')) as {
      statusLine?: { command: string }
      trustedWorkspaces?: string[]
    }
    expect(yolo.statusLine?.command).toContain('--session sess-yolo --launch launch-1')
    expect(yolo.trustedWorkspaces).toEqual([
      'Q:\\Existing\\Workspace',
      'Q:\\Work\\Tree',
      'q:\\Work\\Tree',
    ])
    expect(readFileSync(userSettingsFile, 'utf8')).toBe(userSettingsText)
  })

  it('still writes trustedWorkspaces when statusLine is disabled or the relay cannot be installed', () => {
    const root = tempDir()
    const relay = new AntigravityStatusLine({
      directory: join(root, 'statusline'),
      snapshots: join(root, 'snapshots'),
      identities: join(root, 'identities'),
      antigravityHome: join(root, 'agy-home'),
      tools: { node: () => ({ ok: false, detail: 'node missing' }) },
      report: () => undefined,
      platform: 'linux',
    })

    expect(relay.settingsFileFor(undefined, { includeStatusLine: false })).toBeNull()

    const oneShotFile = relay.settingsFileFor(undefined, {
      includeStatusLine: false,
      trustedDirectory: '/work/project/',
    })
    expect(oneShotFile).not.toBeNull()
    expect(JSON.parse(readFileSync(oneShotFile!, 'utf8'))).toEqual({
      trustedWorkspaces: ['/work/project'],
    })

    const fallbackFile = relay.settingsFileFor(
      { sessionId: 'sess-no-node', launchId: 'launch-1' },
      { trustedDirectory: '/work/project/' },
    )
    expect(fallbackFile).not.toBeNull()
    expect(JSON.parse(readFileSync(fallbackFile!, 'utf8'))).toEqual({
      trustedWorkspaces: ['/work/project'],
    })
  })

  it('normalizes trusted directory candidates on win32 and POSIX', () => {
    expect(AntigravityStatusLine.trustedDirectoryCandidates('q:/Apps/Jamat/.worktrees/001/', 'win32')).toEqual([
      'q:\\Apps\\Jamat\\.worktrees\\001',
      'Q:\\Apps\\Jamat\\.worktrees\\001',
    ])
    expect(AntigravityStatusLine.trustedDirectoryCandidates('Q:\\', 'win32')).toEqual([
      'Q:\\',
      'q:\\',
    ])
    expect(AntigravityStatusLine.trustedDirectoryCandidates('/srv/repo///', 'linux')).toEqual([
      '/srv/repo',
    ])
    expect(AntigravityStatusLine.trustedDirectoryCandidates('/', 'linux')).toEqual(['/'])
  })

  it.runIf(process.platform === 'win32')('includes on-disk NTFS casing with both drive-letter cases on Windows', () => {
    const dir = tempDir()
    const nested = join(dir, 'MixedCaseTree')
    mkdirSync(nested)
    const candidates = AntigravityStatusLine.trustedDirectoryCandidates(nested.toLowerCase(), 'win32')
    const driveLower = `${nested[0].toLowerCase()}${nested.slice(1)}`
    const driveUpper = `${nested[0].toUpperCase()}${nested.slice(1)}`
    expect(candidates).toContain(driveLower)
    expect(candidates).toContain(driveUpper)
  })
})
