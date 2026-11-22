import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { ClaudeLimitReader } from './claudeLimitReader'
import { ClaudeLimitFixtures } from './fixtures/claudeLimitFixtures'

describe('lib-orchestrator/limitRecovery/claudeLimitReader', () => {
  const roots: string[] = []
  afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

  it('reads a five-hour refusal as the session window with its reset in milliseconds', () => {
    expect(ClaudeLimitReader.lastOf(ClaudeLimitFixtures.user() + ClaudeLimitFixtures.assistant() + ClaudeLimitFixtures.limit()))
      .toEqual({ kind: 'limit', recordId: 'limit-1', at: Date.parse('2026-11-18T20:22:17.791Z'), window: 'session',
        resetsAt: ClaudeLimitFixtures.resetsAtSecondsConst * 1_000 })
  })

  it('reads a seven-day refusal as the weekly window', () => {
    const reading = ClaudeLimitReader.lastOf(ClaudeLimitFixtures.limit('w', 'seven_day_opus'))
    expect(reading).toMatchObject({ kind: 'limit', window: 'weekly' })
  })

  it('keeps an unknown limit type as other and a missing reset as null', () => {
    const line = ClaudeLimitFixtures.line({ type: 'assistant', uuid: 'x', isApiErrorMessage: true, error: 'rate_limit' })
    expect(ClaudeLimitReader.lastOf(line)).toEqual({ kind: 'limit', recordId: 'x', at: 0, window: 'other', resetsAt: null })
  })

  it('ends the limit at a newer user turn', () => {
    expect(ClaudeLimitReader.lastOf(ClaudeLimitFixtures.limit() + ClaudeLimitFixtures.user('u-2'))).toEqual({ kind: 'none' })
  })

  it('ignores a sub-agent record and records that are no turn after the refusal', () => {
    const content = ClaudeLimitFixtures.limit()
      + ClaudeLimitFixtures.line({ type: 'user', uuid: 's', isSidechain: true })
      + ClaudeLimitFixtures.line({ type: 'system', uuid: 'sys' })
    expect(ClaudeLimitReader.lastOf(content)).toMatchObject({ kind: 'limit', recordId: 'limit-1' })
  })

  it('answers none for an ordinary answer, another API error and a torn line', () => {
    expect(ClaudeLimitReader.lastOf(ClaudeLimitFixtures.assistant())).toEqual({ kind: 'none' })
    expect(ClaudeLimitReader.lastOf(ClaudeLimitFixtures.line({ type: 'assistant', uuid: 'e', isApiErrorMessage: true,
      error: 'authentication_failed' }))).toEqual({ kind: 'none' })
    expect(ClaudeLimitReader.lastOf('{"type":"assist')).toEqual({ kind: 'none' })
  })

  it('reads the tail of the resolved file and answers none without a transcript', async () => {
    const root = await mkdtemp(join(tmpdir(), 'limit-reader-'))
    roots.push(root)
    const file = join(root, 'session.jsonl')
    await writeFile(file, ClaudeLimitFixtures.user() + ClaudeLimitFixtures.limit())
    const stats = await stat(file)
    let found = true
    const reader = new ClaudeLimitReader({
      async resolve(input) {
        return found ? { agentId: input.agentId, nativeSessionId: input.nativeSessionId, file, mtimeMs: stats.mtimeMs, size: stats.size } : null
      },
    })
    expect(await reader.read({ cwd: root, nativeSessionId: 'session' })).toMatchObject({ kind: 'limit', recordId: 'limit-1' })
    found = false
    expect(await reader.read({ cwd: root, nativeSessionId: 'session' })).toEqual({ kind: 'none' })
  })
})
