import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { AntigravityUsageParser } from './antigravityUsageParser'
import { TokenUsageScanner } from './tokenUsageScanner'

describe('lib-orchestrator/tokenUsage/antigravityUsageParser', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('scans Antigravity brain transcripts and ignores chunk duplicates', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jamat-agy-usage-'))
    roots.push(root)
    const logsDir = join(root, 'brain', 'conv-123', '.system_generated', 'logs')
    const chunksDir = join(logsDir, 'chunks', 'transcript')
    mkdirSync(chunksDir, { recursive: true })
    const content = [
      JSON.stringify({
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-21T14:39:15Z',
        model: 'gemini-4-neon-high',
        input_tokens: 2500,
        cache_read_tokens: 7500,
        output_tokens: 250,
      }),
      '',
    ].join('\n')
    writeFileSync(join(logsDir, 'transcript.jsonl'), content)
    writeFileSync(join(logsDir, 'transcript_full.jsonl'), content)
    writeFileSync(join(chunksDir, '00000000.jsonl'), content)

    const scanner = new TokenUsageScanner({
      sources: [AntigravityUsageParser.source(root)],
      cacheFile: join(root, 'cache.json'),
      resolveAccount: () => 'main',
      resolveProject: (_cwd, nativeId, agentId) => `${agentId}:${nativeId}`,
    })
    const buckets = await scanner.scan()
    expect(buckets).toHaveLength(1)
    expect(buckets[0]).toMatchObject({
      agentId: 'antigravity',
      accountId: 'main',
      projectKey: 'antigravity:conv-123',
      model: 'gemini-4-neon-high',
      input: 2500,
      output: 250,
      cacheRead: 7500,
      cacheWrite: 0,
    })
  })
})
