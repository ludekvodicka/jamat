import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { SessionModelSourceAntigravity } from './sessionModelSourceAntigravity'

describe('lib-orchestrator/sessionModelReader/antigravity/sessionModelSourceAntigravity', () => {
  const roots: string[] = []

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'jamat-agy-model-'))
    roots.push(dir)
    return dir
  }

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('reads model, effort, context tokens and enriches with status line context window snapshot', async () => {
    const root = tempDir()
    const file = join(root, 'transcript.jsonl')
    writeFileSync(file, [
      JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: '<USER_REQUEST>\nhi\n</USER_REQUEST>' }),
      JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', model: 'gemini-4-neon-high', input_tokens: 2500, cache_read_tokens: 7500, output_tokens: 200 }),
    ].join('\n'))
    const snapshots = join(root, 'snapshots')
    const snapshotFile = join(snapshots, 'conv-1.json')
    const stats = statSync(file)

    const withoutSnapshot = await new SessionModelSourceAntigravity(snapshots).read(
      { agentId: 'antigravity', nativeSessionId: 'conv-1', file, mtimeMs: stats.mtimeMs, size: stats.size },
      { agentId: 'antigravity', cwd: root, nativeSessionId: 'conv-1', launchModel: null },
    )
    expect(withoutSnapshot).toEqual({
      kind: 'ok',
      info: {
        model: 'gemini-4-neon-high',
        modelLabel: 'Gemini 4 Neon',
        effortLevel: 'high',
        contextTokens: 10_000,
        contextWindow: null,
      },
    })

    const { mkdirSync } = await import('node:fs')
    mkdirSync(snapshots, { recursive: true })
    writeFileSync(snapshotFile, JSON.stringify({
      schemaVersion: 1,
      model: 'Gemini 4 Neon (High)',
      displayName: 'Gemini 4 Neon (High)',
      contextWindowSize: 1_000_000,
    }))
    const withSnapshot = await new SessionModelSourceAntigravity(snapshots).read(
      { agentId: 'antigravity', nativeSessionId: 'conv-1', file, mtimeMs: stats.mtimeMs, size: stats.size },
      { agentId: 'antigravity', cwd: root, nativeSessionId: 'conv-1', launchModel: null },
    )
    expect(withSnapshot).toEqual({
      kind: 'ok',
      info: {
        model: 'gemini-4-neon-high',
        modelLabel: 'Gemini 4 Neon (High)',
        effortLevel: 'high',
        contextTokens: 10_000,
        contextWindow: 1_000_000,
      },
    })
  })

  it('falls back to status line snapshot when transcript has no planner response yet', async () => {
    const root = tempDir()
    const file = join(root, 'transcript.jsonl')
    writeFileSync(file, JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: 'hi' }) + '\n')
    const snapshots = join(root, 'snapshots')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(snapshots, { recursive: true })
    writeFileSync(join(snapshots, 'conv-2.json'), JSON.stringify({
      schemaVersion: 1,
      model: 'Gemini 4 Argon (Medium)',
      displayName: 'Gemini 4 Argon (Medium)',
      effort: 'medium',
      contextWindowSize: 1_000_000,
      usedPercentage: 5,
    }))
    const stats = statSync(file)
    const reading = await new SessionModelSourceAntigravity(snapshots).read(
      { agentId: 'antigravity', nativeSessionId: 'conv-2', file, mtimeMs: stats.mtimeMs, size: stats.size },
      { agentId: 'antigravity', cwd: root, nativeSessionId: 'conv-2', launchModel: null },
    )
    expect(reading).toEqual({
      kind: 'ok',
      info: {
        model: 'Gemini 4 Argon (Medium)',
        modelLabel: 'Gemini 4 Argon (Medium)',
        effortLevel: 'medium',
        contextTokens: 50_000,
        contextWindow: 1_000_000,
      },
    })
  })

  it('reads pending per-session statusLine snapshot before conversation id exists and reflects mid-session model switch', async () => {
    const root = tempDir()
    const snapshots = join(root, 'snapshots')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(snapshots, { recursive: true })
    writeFileSync(join(snapshots, 'session-sess-1.json'), JSON.stringify({
      schemaVersion: 1,
      model: 'gemini-4-argon-high',
      displayName: 'Gemini 4 Argon (High)',
      effort: 'high',
      contextWindowSize: 1_000_000,
      usedPercentage: 2,
    }))
    const source = new SessionModelSourceAntigravity(snapshots)
    expect(await source.readSessionSnapshot('sess-1')).toEqual({
      kind: 'ok',
      info: {
        model: 'gemini-4-argon-high',
        modelLabel: 'Gemini 4 Argon (High)',
        effortLevel: 'high',
        contextTokens: 20_000,
        contextWindow: 1_000_000,
      },
    })
    expect(await source.readSessionSnapshot('missing')).toEqual({
      kind: 'none',
      reason: 'no antigravity session snapshot',
    })
  })
})
