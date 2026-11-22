import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { FileChangesLogSourceAntigravity } from './fileChangesLogSourceAntigravity'

describe('lib-orchestrator/fileChangesManager/logs/fileChangesLogSourceAntigravity', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('groups edit_file, write_file and run_command calls under user messages and unwraps JSON-quoted args', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jamat-agy-fc-'))
    roots.push(root)
    const file = join(root, 'transcript.jsonl')
    const targetFile = join(root, 'src', 'app.ts')
    writeFileSync(file, [
      JSON.stringify({
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        created_at: '2026-11-21T14:40:00Z',
        content: '<USER_REQUEST>\nUpdate app.ts\n</USER_REQUEST>',
      }),
      JSON.stringify({
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-21T14:40:05Z',
        tool_calls: [
          {
            name: 'edit_file',
            args: {
              Path: JSON.stringify(targetFile),
              Target: JSON.stringify('old'),
              Replacement: JSON.stringify('new'),
            },
          },
          {
            name: 'run_command',
            args: {
              CommandLine: JSON.stringify('pnpm test'),
            },
          },
        ],
      }),
    ].join('\n'))
    const stats = statSync(file)
    const source = new FileChangesLogSourceAntigravity()
    const ref = { agentId: 'antigravity' as const, nativeSessionId: 'conv-1', file, mtimeMs: stats.mtimeMs, size: stats.size }
    const groups = await source.load(ref, root, [])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.message).toBe('Update app.ts')
    expect(groups[0]?.mutations).toHaveLength(1)
    expect(groups[0]?.mutations[0]).toMatchObject({
      kind: 'update',
      path: targetFile,
      oldText: 'old',
      newText: 'new',
      location: 'workspace',
    })
    const shells = await source.shellRuns(ref, [])
    expect(shells).toEqual([
      { command: 'pnpm test', startedAt: Date.parse('2026-11-21T14:40:05Z'), endedAt: Date.parse('2026-11-21T14:40:05Z') },
    ])
  })
})
