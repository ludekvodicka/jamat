import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { CodexAppServerAnswer } from '../../rateMonitor/codex/codexAppServerClient'
import { CodexHistoryEraser } from './codexHistoryEraser'

describe('lib-orchestrator/sessionManager/purge/codexHistoryEraser', () => {
  const thread = '01a1b150-6a3f-74b3-b21a-5d0ecba4ebdc'
  const child = '01a1b150-6a3f-74b3-b21a-5d0ecba4ebdd'
  const other = '019f6128-5df8-77a3-8ffd-233be96332e4'
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'jamat-codex-erase-'))
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  const eraser = (answers: Record<string, CodexAppServerAnswer>, deleted: string[], closed: { count: number }): CodexHistoryEraser =>
    new CodexHistoryEraser({
      home,
      childrenOf: (threadId) => Promise.resolve(threadId === thread ? [child] : []),
      client: () => ({
        deleteThread: (threadId) => {
          deleted.push(threadId)
          return Promise.resolve(answers[threadId] ?? { ok: true, result: {} })
        },
        close: () => {
          closed.count++
          return Promise.resolve(true)
        },
      }),
    })

  it('deletes the thread and its children through Codex and drops their prompt and name lines', async () => {
    writeFileSync(join(home, 'history.jsonl'), [
      JSON.stringify({ session_id: thread, text: 'private' }),
      JSON.stringify({ session_id: other, text: 'kept' }),
      JSON.stringify({ session_id: child, text: 'child' }),
      '',
    ].join('\n'))
    writeFileSync(join(home, 'session_index.jsonl'), `${JSON.stringify({ id: thread, thread_name: 'private' })}\n`)
    const deleted: string[] = []
    const closed = { count: 0 }

    const report = await eraser({
      [child]: { ok: false, code: 'failed', reason: `no rollout found for thread id ${child}` },
    }, deleted, closed).erase({ nativeSessionIds: [thread], cwd: 'Q:\\work', since: 0 })

    expect(deleted).toEqual([thread, child])
    expect(closed.count).toBe(1)
    expect(report.erased).toEqual([
      `Codex thread ${thread}`,
      `2 line(s) of ${join(home, 'history.jsonl')}`,
      `1 line(s) of ${join(home, 'session_index.jsonl')}`,
    ])
    expect(report.leftovers).toEqual([])
    expect(readFileSync(join(home, 'history.jsonl'), 'utf8')).toBe(`${JSON.stringify({ session_id: other, text: 'kept' })}\n`)
    expect(readFileSync(join(home, 'session_index.jsonl'), 'utf8')).toBe('')
  })

  it('names a thread Codex could not delete', async () => {
    const closed = { count: 0 }

    const report = await eraser({ [thread]: { ok: false, code: 'not-installed', reason: 'Codex is not installed' } }, [], closed)
      .erase({ nativeSessionIds: [thread], cwd: 'Q:\\work', since: 0 })

    expect(report.leftovers).toEqual([`Codex thread ${thread}: Codex is not installed`])
    expect(closed.count).toBe(1)
  })
})
