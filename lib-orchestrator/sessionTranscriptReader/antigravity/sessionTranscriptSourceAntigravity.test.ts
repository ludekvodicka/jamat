import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { SessionTranscriptSourceAntigravity } from './sessionTranscriptSourceAntigravity'

describe('lib-orchestrator/sessionTranscriptReader/antigravity/sessionTranscriptSourceAntigravity', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('extracts unwrapped user requests and assistant replies while ignoring tool-only and system steps', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jamat-agy-tx-'))
    roots.push(root)
    const file = join(root, 'transcript.jsonl')
    writeFileSync(file, [
      JSON.stringify({
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        created_at: '2026-11-21T14:39:05Z',
        content: '<USER_REQUEST>\nvidis kod?\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nmeta\n</ADDITIONAL_METADATA>',
      }),
      JSON.stringify({
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-21T14:39:06Z',
        tool_calls: [{ name: 'run_command', args: {} }],
      }),
      JSON.stringify({
        step_index: 2,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        created_at: '2026-11-21T14:39:07Z',
        content: 'reminder',
      }),
      JSON.stringify({
        step_index: 3,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-21T14:39:15Z',
        content: 'Ano, vidím workspace.',
      }),
    ].join('\n'))
    const stats = statSync(file)
    const reading = await new SessionTranscriptSourceAntigravity().read(
      { agentId: 'antigravity', nativeSessionId: 'conv-1', file, mtimeMs: stats.mtimeMs, size: stats.size },
      { maxMessages: 10, maxCharactersPerMessage: 2000 },
    )
    expect(reading.kind).toBe('messages')
    if (reading.kind !== 'messages') return
    expect(reading.messages).toEqual([
      { role: 'user', text: 'vidis kod?', at: Date.parse('2026-11-21T14:39:05Z'), textTruncated: false },
      { role: 'assistant', text: 'Ano, vidím workspace.', at: Date.parse('2026-11-21T14:39:15Z'), textTruncated: false },
    ])
  })
})
