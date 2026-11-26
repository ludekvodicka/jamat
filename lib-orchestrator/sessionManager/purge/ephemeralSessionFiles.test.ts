import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { OrchestratorPaths } from '../../shared/orchestratorPaths'
import type { SessionRecord } from '../records/sessionRecord.types'
import { EphemeralSessionFiles } from './ephemeralSessionFiles'

function recordOf(
  sessionId: string,
  agent?: { agentId: 'claude' | 'antigravity' | 'codex'; nativeSessionId?: string; unverifiedNativeSessionId?: string },
): SessionRecord {
  return {
    sessionId,
    kind: agent === undefined ? 'shell' : 'agent',
    title: sessionId,
    directory: { mode: 'adHoc', path: 'C:/work' },
    life: 'ended',
    binding: null,
    createdAt: 1,
    ...(agent === undefined ? {} : { agent: { launchMode: 'new', ...agent } }),
  }
}

describe('lib-orchestrator/sessionManager/purge/ephemeralSessionFiles', () => {
  const roots: string[] = []
  let previousStateRoot: string | undefined

  beforeEach(() => {
    previousStateRoot = process.env.JAMAT_V3_LOCAL_STATE_DIR
  })

  afterEach(() => {
    if (previousStateRoot === undefined) delete process.env.JAMAT_V3_LOCAL_STATE_DIR
    else process.env.JAMAT_V3_LOCAL_STATE_DIR = previousStateRoot
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function seed(directory: string, name: string, mtimeMs?: number): string {
    mkdirSync(directory, { recursive: true })
    const file = join(directory, name)
    writeFileSync(file, '{}', 'utf8')
    if (mtimeMs !== undefined) utimesSync(file, mtimeMs / 1000, mtimeMs / 1000)
    return file
  }

  it('removes ephemeral statusline, identity and unshared context files for removed sessions while preserving codex-sessions and shared conversations', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jamat-ephemeral-remove-'))
    roots.push(root)
    process.env.JAMAT_V3_LOCAL_STATE_DIR = root
    const instance = { configIdentity: 'cfg', channel: 'development' as const }
    const cleaner = new EphemeralSessionFiles({ instance })

    const claudeSettings = seed(OrchestratorPaths.claudeStatusLineDirectory('cfg', 'development'), 'settings-s-removed.json')
    const claudeRelay = seed(OrchestratorPaths.claudeStatusLineDirectory('cfg', 'development'), 'relay.cjs')
    const claudeRelayCmd = seed(OrchestratorPaths.claudeStatusLineDirectory('cfg', 'development'), 'relay.cmd')
    const claudeId = seed(OrchestratorPaths.claudeIdentitiesDirectory('cfg', 'development'), 's-removed.json')
    const claudeCtxExclusive = seed(OrchestratorPaths.claudeContextSnapshotsDirectory('cfg', 'development'), 'conv-exclusive.json')
    const claudeCtxShared = seed(OrchestratorPaths.claudeContextSnapshotsDirectory('cfg', 'development'), 'conv-shared.json')
    const agySettings = seed(OrchestratorPaths.antigravityStatusLineDirectory('cfg', 'development'), 'settings-s-removed.json')
    const agyRelay = seed(OrchestratorPaths.antigravityStatusLineDirectory('cfg', 'development'), 'relay.cjs')
    const agyId = seed(OrchestratorPaths.antigravityIdentitiesDirectory('cfg', 'development'), 's-removed.json')
    const agySessionCtx = seed(OrchestratorPaths.antigravityContextSnapshotsDirectory('cfg', 'development'), 'session-s-removed.json')
    const agyConvCtx = seed(OrchestratorPaths.antigravityContextSnapshotsDirectory('cfg', 'development'), 'conv-exclusive.json')
    const codexDir = join(OrchestratorPaths.codexSessionsDirectory('cfg', 'development'), 's-removed')
    const codexFile = seed(codexDir, 'launch.json')

    const removedRecord = recordOf('s-removed', {
      agentId: 'claude',
      nativeSessionId: 'conv-exclusive',
      unverifiedNativeSessionId: 'conv-shared',
    })
    const count = await cleaner.removeForSessions(
      [removedRecord],
      new Set(['conv-shared']),
      { includeConversationContext: true },
    )

    expect(count).toBe(7)
    expect(existsSync(claudeSettings)).toBe(false)
    expect(existsSync(claudeId)).toBe(false)
    expect(existsSync(claudeCtxExclusive)).toBe(false)
    expect(existsSync(agySettings)).toBe(false)
    expect(existsSync(agyId)).toBe(false)
    expect(existsSync(agySessionCtx)).toBe(false)
    expect(existsSync(agyConvCtx)).toBe(false)
    // Shared relays, shared conversation context and codex-sessions stay intact.
    expect(existsSync(claudeRelay)).toBe(true)
    expect(existsSync(claudeRelayCmd)).toBe(true)
    expect(existsSync(agyRelay)).toBe(true)
    expect(existsSync(claudeCtxShared)).toBe(true)
    expect(existsSync(codexFile)).toBe(true)
  })

  it('keeps conversation context snapshots when archiving while cleaning per-session statusline and identity files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jamat-ephemeral-archive-'))
    roots.push(root)
    process.env.JAMAT_V3_LOCAL_STATE_DIR = root
    const instance = { configIdentity: 'cfg', channel: 'development' as const }
    const cleaner = new EphemeralSessionFiles({ instance })

    const claudeSettings = seed(OrchestratorPaths.claudeStatusLineDirectory('cfg', 'development'), 'settings-s-arch.json')
    const claudeId = seed(OrchestratorPaths.claudeIdentitiesDirectory('cfg', 'development'), 's-arch.json')
    const claudeCtx = seed(OrchestratorPaths.claudeContextSnapshotsDirectory('cfg', 'development'), 'conv-arch.json')
    const agySessionCtx = seed(OrchestratorPaths.antigravityContextSnapshotsDirectory('cfg', 'development'), 'session-s-arch.json')

    const archived = recordOf('s-arch', { agentId: 'claude', nativeSessionId: 'conv-arch' })
    const count = await cleaner.removeForSessions([archived], new Set(), { includeConversationContext: false })

    expect(count).toBe(3)
    expect(existsSync(claudeSettings)).toBe(false)
    expect(existsSync(claudeId)).toBe(false)
    expect(existsSync(agySessionCtx)).toBe(false)
    expect(existsSync(claudeCtx)).toBe(true)
  })

  it('sweeps only stale unknown files older than 7 days and preserves shared relays, recent files and known sessions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jamat-ephemeral-sweep-'))
    roots.push(root)
    process.env.JAMAT_V3_LOCAL_STATE_DIR = root
    const now = Date.UTC(2026, 10, 26, 12, 0, 0)
    const oldMs = now - EphemeralSessionFiles.maxAgeMillisecondsConst - 60_000
    const recentMs = now - EphemeralSessionFiles.maxAgeMillisecondsConst + 60_000
    const instance = { configIdentity: 'cfg', channel: 'development' as const }
    const cleaner = new EphemeralSessionFiles({ instance, now: () => now })

    const claudeDir = OrchestratorPaths.claudeStatusLineDirectory('cfg', 'development')
    const claudeIdDir = OrchestratorPaths.claudeIdentitiesDirectory('cfg', 'development')
    const claudeCtxDir = OrchestratorPaths.claudeContextSnapshotsDirectory('cfg', 'development')
    const agyDir = OrchestratorPaths.antigravityStatusLineDirectory('cfg', 'development')
    const agyIdDir = OrchestratorPaths.antigravityIdentitiesDirectory('cfg', 'development')
    const agyCtxDir = OrchestratorPaths.antigravityContextSnapshotsDirectory('cfg', 'development')

    // Stale unknown files (should be swept)
    const staleFiles = [
      seed(claudeDir, 'settings-orphan.json', oldMs),
      seed(claudeIdDir, 'orphan.json', oldMs),
      seed(claudeCtxDir, 'orphan-conv.json', oldMs),
      seed(agyDir, 'settings-orphan.json', oldMs),
      seed(agyIdDir, 'orphan.json', oldMs),
      seed(agyCtxDir, 'session-orphan.json', oldMs),
      seed(agyCtxDir, 'orphan-conv.json', oldMs),
    ]

    // Preserved files: shared relays (even if old), recent unknown files, and old known session/conversation files
    const preservedFiles = [
      seed(claudeDir, 'relay.cjs', oldMs),
      seed(claudeDir, 'relay.cmd', oldMs),
      seed(claudeDir, 'relay.sh', oldMs),
      seed(agyDir, 'relay.cjs', oldMs),
      seed(agyDir, 'relay.cmd', oldMs),
      seed(agyDir, 'relay.sh', oldMs),
      seed(claudeDir, 'settings-recent-unknown.json', recentMs),
      seed(claudeIdDir, 'recent-unknown.json', recentMs),
      seed(claudeCtxDir, 'recent-unknown-conv.json', recentMs),
      seed(agyCtxDir, 'session-recent-unknown.json', recentMs),
      seed(claudeDir, 'settings-known.json', oldMs),
      seed(claudeIdDir, 'known.json', oldMs),
      seed(claudeCtxDir, 'known-conv.json', oldMs),
      seed(agyDir, 'settings-known.json', oldMs),
      seed(agyIdDir, 'known.json', oldMs),
      seed(agyCtxDir, 'session-known.json', oldMs),
      seed(agyCtxDir, 'known-conv.json', oldMs),
    ]

    const known = [recordOf('known', { agentId: 'claude', nativeSessionId: 'known-conv' })]
    const removed = await cleaner.sweepStale(known)

    expect(removed).toBe(staleFiles.length)
    for (const file of staleFiles) expect(existsSync(file)).toBe(false)
    for (const file of preservedFiles) expect(existsSync(file)).toBe(true)
  })
})
