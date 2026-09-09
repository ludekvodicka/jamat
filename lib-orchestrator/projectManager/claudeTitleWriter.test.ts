import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ClaudeSessionSource } from './providers/claude/claudeSessionSource'
import { ClaudeTitleWriter } from './claudeTitleWriter'

describe('lib-orchestrator/projectManager/claudeTitleWriter', () => {
  const created: string[] = []
  const cwd = 'C:/Projects/Alpha'
  const sessionId = '11111111-1111-4111-8111-111111111111'

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  interface Harness {
    home: string
    store: string
    writer: ClaudeTitleWriter
    reports: string[]
  }

  function harness(): Harness {
    const home = mkdtempSync(join(tmpdir(), 'jamat-v3-claude-title-writer-'))
    created.push(home)
    const store = join(home, 'projects', 'C--Projects-Alpha')
    mkdirSync(store, { recursive: true })
    const reports: string[] = []
    return {
      home,
      store,
      reports,
      writer: ClaudeTitleWriter.load({ claudeHome: home, report: (message) => reports.push(message) }),
    }
  }

  function writeTranscript(store: string, id: string, content?: string): string {
    const file = join(store, `${id}.jsonl`)
    writeFileSync(
      file,
      content ?? `{"type":"summary","sessionId":"${id}","slug":"original-slug"}\n`,
      'utf8',
    )
    return file
  }

  function transcriptLines(file: string): string[] {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean)
  }

  async function titleReadBack(home: string): Promise<string | null | undefined> {
    const source = new ClaudeSessionSource({ claudeHome: home })
    const [summary] = await source.listProjectSessions(cwd, { limit: 10 })
    return summary?.title
  }

  it('appends the record the session source reads back, and the last append wins', async () => {
    const { home, store, writer } = harness()
    writeTranscript(store, sessionId)

    expect(await writer.appendTitle({ cwd, nativeSessionId: sessionId, title: 'The new name' }))
      .toBe(true)
    expect(await titleReadBack(home)).toBe('The new name')

    expect(await writer.appendTitle({ cwd, nativeSessionId: sessionId, title: 'The newer name' }))
      .toBe(true)
    expect(await titleReadBack(home)).toBe('The newer name')
  })

  it('prepends a newline onto a tail that has none, keeping the transcript line-parseable', async () => {
    const { home, store, writer } = harness()
    const file = writeTranscript(
      store,
      sessionId,
      `{"type":"summary","sessionId":"${sessionId}","slug":"original-slug"}`,
    )

    expect(await writer.appendTitle({ cwd, nativeSessionId: sessionId, title: 'Guarded' })).toBe(true)

    const lines = transcriptLines(file)
    expect(lines).toHaveLength(2)
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow()
    expect(JSON.parse(lines[1] ?? '')).toEqual({
      type: 'custom-title',
      customTitle: 'Guarded',
      sessionId,
    })
    expect(await titleReadBack(home)).toBe('Guarded')
  })

  it('refuses a transcript that does not exist and never creates one', async () => {
    const { store, writer } = harness()

    expect(await writer.appendTitle({ cwd, nativeSessionId: sessionId, title: 'A name' })).toBe(false)
    expect(existsSync(join(store, `${sessionId}.jsonl`))).toBe(false)
  })

  it('refuses a malformed session id before touching the store', async () => {
    const { store, writer } = harness()

    expect(await writer.appendTitle({ cwd, nativeSessionId: 'not-a-uuid', title: 'A name' }))
      .toBe(false)
    expect(existsSync(join(store, 'not-a-uuid.jsonl'))).toBe(false)
  })

  it('refuses a name that is empty once normalized', async () => {
    const { store, writer } = harness()
    const file = writeTranscript(store, sessionId)

    expect(await writer.appendTitle({ cwd, nativeSessionId: sessionId, title: ' \r\n \n ' }))
      .toBe(false)
    expect(transcriptLines(file)).toHaveLength(1)
  })

  it('collapses newlines and caps the name at 200 characters', async () => {
    const { store, writer } = harness()
    const file = writeTranscript(store, sessionId)

    const title = `first\r\nsecond\nthird ${'x'.repeat(300)}`
    expect(await writer.appendTitle({ cwd, nativeSessionId: sessionId, title })).toBe(true)

    const lines = transcriptLines(file)
    const record = JSON.parse(lines[1] ?? '') as { customTitle: string }
    expect(record.customTitle.startsWith('first second third ')).toBe(true)
    expect(record.customTitle).toHaveLength(200)
    expect(record.customTitle).not.toContain('\n')
  })

  // The cap counts code points: a cut through an astral pair would end the title on a lone high
  // surrogate, which JSON.stringify escapes into a record a strict JSON reader refuses.
  it('never cuts the cap through an emoji', async () => {
    const { store, writer } = harness()
    const file = writeTranscript(store, sessionId)

    // 199 units, then an emoji whose pair straddles the 200th UTF-16 unit, then more text.
    const title = `${'x'.repeat(199)}😀 and more`
    expect(await writer.appendTitle({ cwd, nativeSessionId: sessionId, title })).toBe(true)

    const lines = transcriptLines(file)
    const record = JSON.parse(lines[1] ?? '') as { customTitle: string }
    expect([...record.customTitle]).toHaveLength(200)
    expect(record.customTitle.endsWith('😀')).toBe(true)
    expect(/[\uD800-\uDBFF]$/.test(record.customTitle)).toBe(false)
  })
})
