import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { CodexSessionSource } from './codexSessionSource'

describe('lib-orchestrator/projectManager/providers/codex/codexSessionSource', () => {
  const created: string[] = []
  const projectDir = 'Q:/Projects/AppFixture'
  const namedId = '019f4bf7-b5d8-74b0-9175-a5a5938a4082'
  const erasedNameId = '019f4c11-2a3b-7c4d-8e5f-6a7b8c9d0e1f'
  const unnamedId = '019f4d22-3b4c-8d5e-9f60-1a2b3c4d5e6f'

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  interface Harness {
    codexHome: string
    source: CodexSessionSource
  }

  function harness(): Harness {
    const codexHome = mkdtempSync(join(tmpdir(), 'jamat-v3-codex-source-'))
    created.push(codexHome)
    writeFileSync(join(codexHome, 'session_index.jsonl'), fixture('session-index.jsonl'), 'utf8')
    return { codexHome, source: new CodexSessionSource({ codexHome }) }
  }

  function fixture(name: string): string {
    return readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8')
  }

  function pad(value: number): string {
    return String(value).padStart(2, '0')
  }

  function writeRollout(
    codexHome: string,
    options: { daysAgo: number; sessionId: string; fixture: string; mtime?: Date },
  ): { file: string; createdAt: number; mtimeMilliseconds: number } {
    const at = new Date(Date.now() - options.daysAgo * 86_400_000)
    const year = String(at.getFullYear())
    const month = pad(at.getMonth() + 1)
    const day = pad(at.getDate())
    const stamp = `${year}-${month}-${day}T${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}`
    const directory = join(codexHome, 'sessions', year, month, day)
    mkdirSync(directory, { recursive: true })
    const file = join(directory, `rollout-${stamp}-${options.sessionId}.jsonl`)
    writeFileSync(file, fixture(options.fixture), 'utf8')
    if (options.mtime) utimesSync(file, options.mtime, options.mtime)
    return {
      file,
      createdAt: Date.parse(stamp.replace(/T(\d{2})-(\d{2})-(\d{2})$/, 'T$1:$2:$3')),
      mtimeMilliseconds: statSync(file).mtimeMs,
    }
  }

  // Identity and creation time come from the file name, recency from the file itself.
  it('builds a summary out of the file name, the file stat and the thread names', async () => {
    const { codexHome, source } = harness()
    const rollout = writeRollout(codexHome, {
      daysAgo: 2,
      sessionId: namedId,
      fixture: 'rollout-injected-blocks.jsonl',
      mtime: new Date(Date.now() - 3_600_000),
    })

    expect(await source.listProjectSessions(projectDir, { limit: 200 })).toEqual([{
      agentId: 'codex',
      nativeSessionId: namedId,
      title: 'Renamed later',
      firstUserMessage: 'Refactor the rollout index',
      createdAt: rollout.createdAt,
      lastActivity: rollout.mtimeMilliseconds,
      active: false,
    }])
  })

  // Codex has no pid to check, and an old rollout must never look like a running session.
  it('never marks a session active', async () => {
    const { codexHome, source } = harness()
    writeRollout(codexHome, { daysAgo: 0, sessionId: namedId, fixture: 'rollout-event-user-message.jsonl' })
    writeRollout(codexHome, { daysAgo: 4, sessionId: unnamedId, fixture: 'rollout-injected-blocks.jsonl' })

    const sessions = await source.listProjectSessions(projectDir, { limit: 200 })
    expect(sessions).toHaveLength(2)
    expect(sessions.every((session) => !session.active)).toBe(true)
  })

  it('takes an explicit user message over the injected context blocks', async () => {
    const { codexHome, source } = harness()
    writeRollout(codexHome, { daysAgo: 1, sessionId: unnamedId, fixture: 'rollout-event-user-message.jsonl' })

    const [session] = await source.listProjectSessions(projectDir, { limit: 200 })
    expect(session.firstUserMessage).toBe('Plain hello from the event stream')
  })

  it('reports no title when the thread was never named', async () => {
    const { codexHome, source } = harness()
    writeRollout(codexHome, { daysAgo: 1, sessionId: unnamedId, fixture: 'rollout-injected-blocks.jsonl' })
    writeRollout(codexHome, { daysAgo: 2, sessionId: erasedNameId, fixture: 'rollout-injected-blocks.jsonl' })

    const sessions = await source.listProjectSessions(projectDir, { limit: 200 })
    expect(sessions.map((session) => session.title)).toEqual([null, null])
  })

  it('sorts by last activity and cuts to the limit', async () => {
    const { codexHome, source } = harness()
    const oldest = writeRollout(codexHome, { daysAgo: 1, sessionId: namedId, fixture: 'rollout-injected-blocks.jsonl', mtime: new Date(Date.now() - 90_000_000) })
    const middle = writeRollout(codexHome, { daysAgo: 2, sessionId: erasedNameId, fixture: 'rollout-injected-blocks.jsonl', mtime: new Date(Date.now() - 50_000_000) })
    const newest = writeRollout(codexHome, { daysAgo: 3, sessionId: unnamedId, fixture: 'rollout-injected-blocks.jsonl', mtime: new Date(Date.now() - 10_000_000) })

    const all = await source.listProjectSessions(projectDir, { limit: 200 })
    expect(all.map((session) => session.lastActivity))
      .toEqual([newest.mtimeMilliseconds, middle.mtimeMilliseconds, oldest.mtimeMilliseconds])

    const limited = await source.listProjectSessions(projectDir, { limit: 2 })
    expect(limited.map((session) => session.nativeSessionId)).toEqual([unnamedId, erasedNameId])
  })

  it('answers the newest activity of a project, and null when it has no sessions', async () => {
    const { codexHome, source } = harness()
    writeRollout(codexHome, { daysAgo: 1, sessionId: namedId, fixture: 'rollout-injected-blocks.jsonl', mtime: new Date(Date.now() - 90_000_000) })
    const newest = writeRollout(codexHome, { daysAgo: 2, sessionId: unnamedId, fixture: 'rollout-injected-blocks.jsonl', mtime: new Date(Date.now() - 10_000_000) })

    expect(await source.latestActivity(projectDir)).toBe(newest.mtimeMilliseconds)
    expect(await source.latestActivity('Q:/Projects/Untouched')).toBeNull()
  })

  it('sees a rollout written after the first listing only once it is invalidated', async () => {
    const { codexHome, source } = harness()
    writeRollout(codexHome, { daysAgo: 1, sessionId: namedId, fixture: 'rollout-injected-blocks.jsonl' })
    expect(await source.listProjectSessions(projectDir, { limit: 200 })).toHaveLength(1)

    writeRollout(codexHome, { daysAgo: 1, sessionId: unnamedId, fixture: 'rollout-event-user-message.jsonl' })
    expect(await source.listProjectSessions(projectDir, { limit: 200 })).toHaveLength(1)

    source.invalidate()
    expect(await source.listProjectSessions(projectDir, { limit: 200 })).toHaveLength(2)
  })

  /**
   * The contract both drivers keep. The facade awaits the two of them in one `Promise.all`, so a
   * driver that rejects on an abort throws away the other driver's finished listing with it.
   */
  it('hands back what it has read when the listing is aborted', async () => {
    const { codexHome, source } = harness()
    writeRollout(codexHome, { daysAgo: 1, sessionId: namedId, fixture: 'rollout-injected-blocks.jsonl' })

    const sessions = await source.listProjectSessions(
      projectDir,
      { limit: 200, signal: AbortSignal.abort() },
    )

    expect(sessions).toEqual([])
  })

  it('names the agent it speaks for', () => {
    const { source } = harness()
    expect(source.agentId).toBe('codex')
  })

  // Codex's own variable, not a JAMAT_V3_ name of ours.
  it('falls back to CODEX_HOME for the store location', () => {
    const previous = process.env.CODEX_HOME
    process.env.CODEX_HOME = 'Q:/elsewhere/.codex'
    try { expect(CodexSessionSource.defaultHome()).toBe('Q:/elsewhere/.codex') }
    finally {
      if (previous === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previous
    }
  })
})
