import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { ClaudeSessionSource } from './claudeSessionSource'

describe('lib-orchestrator/projectManager/providers/claude/claudeSessionSource', () => {
  const created: string[] = []
  const fixturesDirectory = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
  const projectPath = 'C:/Projects/Alpha'
  const customTitleId = '11111111-1111-4111-8111-111111111111'
  const slugId = '22222222-2222-4222-8222-222222222222'
  const plainId = '33333333-3333-4333-8333-333333333333'
  const longMessageId = '44444444-4444-4444-8444-444444444444'

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  interface Harness {
    home: string
    store: string
    source: ClaudeSessionSource
  }

  function harness(): Harness {
    const home = mkdtempSync(join(tmpdir(), 'jamat-v3-claude-source-'))
    created.push(home)
    const store = join(home, 'projects', 'C--Projects-Alpha')
    mkdirSync(store, { recursive: true })
    return { home, store, source: new ClaudeSessionSource({ claudeHome: home }) }
  }

  function copyFixture(store: string, fixture: string, sessionId: string): string {
    const file = join(store, `${sessionId}.jsonl`)
    copyFileSync(join(fixturesDirectory, fixture), file)
    return file
  }

  function writeSessionRecord(home: string, name: string, content: string): void {
    const directory = join(home, 'sessions')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, name), content, 'utf8')
  }

  function setMtime(file: string, isoDate: string): void {
    utimesSync(file, new Date(isoDate), new Date(isoDate))
  }

  function list(source: ClaudeSessionSource, limit = 10) {
    return source.listProjectSessions(projectPath, { limit })
  }

  it('lets a custom title override the slug and reads the first user message', async () => {
    const { store, source } = harness()
    const file = copyFixture(store, 'sessionWithCustomTitle.jsonl', customTitleId)

    const [summary, ...rest] = await list(source)
    expect(rest).toEqual([])
    expect(summary).toEqual({
      agentId: 'claude',
      nativeSessionId: customTitleId,
      title: 'The renamed session',
      firstUserMessage: 'Please review the catalog plan',
      createdAt: statSync(file).birthtimeMs,
      lastActivity: statSync(file).mtimeMs,
      active: false,
    })
  })

  it('falls back to the slug when the session was never renamed', async () => {
    const { store, source } = harness()
    copyFixture(store, 'sessionWithSlug.jsonl', slugId)

    const [summary] = await list(source)
    expect(summary?.title).toBe('catalog-store-review')
  })

  it('falls back to a sanitized first user message when there is no slug', async () => {
    const { store, source } = harness()
    copyFixture(store, 'sessionWithoutSlug.jsonl', plainId)

    const [summary] = await list(source)
    expect(summary?.title).toBeNull()
    expect(summary?.firstUserMessage).toBe('Compare this screenshot with the mock')
  })

  it('truncates a long first message and reads it out of a block list', async () => {
    const { store, source } = harness()
    copyFixture(store, 'sessionWithLongMessage.jsonl', longMessageId)

    const [summary] = await list(source)
    expect(summary?.firstUserMessage).toHaveLength(120)
    expect(summary?.firstUserMessage?.startsWith('Port the Claude session driver')).toBe(true)
    expect(summary?.firstUserMessage).not.toContain('wrote them')
  })

  it('skips what it cannot read and still lists everything beside it', async () => {
    const { store, source } = harness()
    copyFixture(store, 'sessionCorrupt.jsonl', 'corrupt')
    mkdirSync(join(store, 'a-directory.jsonl'))
    copyFixture(store, 'sessionWithSlug.jsonl', slugId)

    expect((await list(source)).map((summary) => summary.nativeSessionId)).toEqual([slugId])
  })

  // The cap is the whole point of the driver: an active transcript is gigabytes long.
  it('reads no metadata past the header byte cap', async () => {
    const { store, source } = harness()
    const oversized = [
      '{"type":"summary","sessionId":"cap-session","slug":"header-slug"}',
      `{"type":"assistant","message":{"content":[{"type":"text","text":"${'x'.repeat(200_000)}"}]}}`,
      '{"type":"user","message":{"content":"BEYOND-THE-HEADER-CAP"}}',
      '',
    ].join('\n')
    writeFileSync(join(store, 'cap-session.jsonl'), oversized, 'utf8')

    const [summary] = await list(source)
    expect(summary?.title).toBe('header-slug')
    expect(summary?.firstUserMessage).toBeNull()
    expect(JSON.stringify(summary)).not.toContain('BEYOND-THE-HEADER-CAP')
  })

  it('reads no metadata past the header line cap', async () => {
    const { store, source } = harness()
    const lines = ['{"type":"summary","sessionId":"line-cap-session","slug":"header-slug"}']
    for (let index = 0; index < 25; index += 1)
      lines.push('{"type":"assistant","message":{"content":[{"type":"text","text":"filler"}]}}')
    lines.push('{"type":"user","message":{"content":"BEYOND-THE-LINE-CAP"}}', '')
    writeFileSync(join(store, 'line-cap-session.jsonl'), lines.join('\n'), 'utf8')

    const [summary] = await list(source)
    expect(summary?.firstUserMessage).toBeNull()
  })

  it('marks a session active only while its recorded pid answers', async () => {
    const { home, store, source } = harness()
    copyFixture(store, 'sessionWithCustomTitle.jsonl', customTitleId)
    copyFixture(store, 'sessionWithSlug.jsonl', slugId)
    writeSessionRecord(home, 'live.json', JSON.stringify({ sessionId: customTitleId, pid: process.pid }))
    // Windows only ever hands out pids that are a multiple of four, so this one can never answer.
    writeSessionRecord(home, 'dead.json', JSON.stringify({ sessionId: slugId, pid: 2147483646 }))
    writeSessionRecord(home, 'garbage.json', 'not json')

    const active = new Map((await list(source)).map((summary) => [summary.nativeSessionId, summary.active]))
    expect(active.get(customTitleId)).toBe(true)
    expect(active.get(slugId)).toBe(false)
  })

  it('orders by last activity, newest first, and cuts the list at the limit', async () => {
    const { store, source } = harness()
    setMtime(copyFixture(store, 'sessionWithCustomTitle.jsonl', customTitleId), '2026-01-01T10:00:00Z')
    setMtime(copyFixture(store, 'sessionWithSlug.jsonl', slugId), '2026-03-01T10:00:00Z')
    setMtime(copyFixture(store, 'sessionWithoutSlug.jsonl', plainId), '2026-02-01T10:00:00Z')

    expect((await list(source)).map((summary) => summary.nativeSessionId))
      .toEqual([slugId, plainId, customTitleId])
    expect((await list(source, 2)).map((summary) => summary.nativeSessionId))
      .toEqual([slugId, plainId])
  })

  it('lists nothing for a project with no store directory', async () => {
    const { source } = harness()
    expect(await source.listProjectSessions('C:/Projects/Unknown', { limit: 10 })).toEqual([])
  })

  it('stops on an aborted signal', async () => {
    const { store, source } = harness()
    copyFixture(store, 'sessionWithSlug.jsonl', slugId)

    const summaries = await source.listProjectSessions(projectPath, {
      limit: 10,
      signal: AbortSignal.abort(),
    })
    expect(summaries).toEqual([])
  })

  // Same size and same mtime as before: only the memo can tell the two readings apart.
  it('memoizes a transcript until invalidate drops the reading', async () => {
    const { store, source } = harness()
    const file = join(store, `${slugId}.jsonl`)
    const fixedDate = new Date('2026-02-02T08:00:00Z')
    writeFileSync(file, `{"type":"summary","sessionId":"${slugId}","slug":"alpha"}\n`, 'utf8')
    utimesSync(file, fixedDate, fixedDate)
    expect((await list(source))[0]?.title).toBe('alpha')

    writeFileSync(file, `{"type":"summary","sessionId":"${slugId}","slug":"omega"}\n`, 'utf8')
    utimesSync(file, fixedDate, fixedDate)
    expect((await list(source))[0]?.title).toBe('alpha')

    source.invalidate()
    expect((await list(source))[0]?.title).toBe('omega')
  })

  it('re-reads a transcript once its mtime or size moved', async () => {
    const { store, source } = harness()
    const file = copyFixture(store, 'sessionWithSlug.jsonl', slugId)
    expect((await list(source))[0]?.title).toBe('catalog-store-review')

    writeFileSync(file, `{"type":"summary","sessionId":"${slugId}","slug":"renamed-by-hand"}\n`, 'utf8')
    expect((await list(source))[0]?.title).toBe('renamed-by-hand')
  })

  it('reports the newest transcript mtime as the project activity', async () => {
    const { store, source } = harness()
    setMtime(copyFixture(store, 'sessionWithCustomTitle.jsonl', customTitleId), '2026-01-01T10:00:00Z')
    const newest = copyFixture(store, 'sessionWithSlug.jsonl', slugId)
    setMtime(newest, '2026-03-01T10:00:00Z')

    expect(await source.latestActivity(projectPath)).toBe(statSync(newest).mtimeMs)
  })

  it('reports no activity for an unknown project or an empty store', async () => {
    const { source } = harness()
    expect(await source.latestActivity('C:/Projects/Unknown')).toBeNull()
    expect(await source.latestActivity(projectPath)).toBeNull()
  })
})
