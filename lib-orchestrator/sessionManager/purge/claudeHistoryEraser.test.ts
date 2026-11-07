import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ClaudeHistoryEraser } from './claudeHistoryEraser'

describe('lib-orchestrator/sessionManager/purge/claudeHistoryEraser', () => {
  const id = '00a3124e-a257-411c-8d8e-3f4cb8ab223b'
  const other = '116b42ca-ecae-46e3-a3cd-50d8f914f756'
  let root: string
  let home: string
  let temporary: string

  const write = (path: string, text = 'x'): void => {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, text)
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'jamat-claude-erase-'))
    home = join(root, '.claude')
    temporary = join(root, 'tmp')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('deletes every per-conversation file and only the prompt lines of that conversation', async () => {
    const project = join(home, 'projects', 'Q--work')
    const memory = join(home, 'projects', 'Q--work', 'memory', 'fact.md')
    write(join(project, `${id}.jsonl`), [
      JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Write', input: { file_path: memory, content: 'secret' } },
        { type: 'tool_use', name: 'Read', input: { file_path: join(project, 'memory', 'read.md') } },
      ] } }),
      '{"half',
    ].join('\n'))
    write(join(project, id, 'subagents', 'agent-a1.jsonl'))
    write(join(project, id, 'tool-results', 'r.txt'))
    write(join(home, 'projects', 'Q--moved', `${id}.jsonl`))
    write(join(project, `${other}.jsonl`))
    write(join(home, 'file-history', id, 'f@v1'))
    write(join(home, 'session-env', id, 'hook.sh'))
    write(join(home, 'tasks', id, 'a.json'))
    write(join(home, 'debug', `${id}.txt`))
    write(join(home, 'todos', `${id}-agent-${id}.json`))
    write(join(home, 'todos', `${other}-agent-${other}.json`))
    write(join(home, 'sessions', '100.json'), JSON.stringify({ pid: 100, sessionId: id }))
    write(join(home, 'sessions', '200.json'), JSON.stringify({ pid: 200, sessionId: other }))
    write(join(home, 'history.jsonl'), [
      JSON.stringify({ display: 'private', sessionId: id }),
      JSON.stringify({ display: `mentions ${id}`, sessionId: other }),
      '',
    ].join('\n'))
    write(join(temporary, 'claude', 'f2f285784bd179bb', id, 'scratchpad', 'a.txt'))
    write(memory, 'secret')

    const report = await new ClaudeHistoryEraser({ homes: () => [home, home], temporaryRoot: temporary })
      .erase({ nativeSessionIds: [id], cwd: 'Q:\\work', since: 0 })

    for (const gone of [
      join(project, `${id}.jsonl`), join(project, id), join(home, 'projects', 'Q--moved', `${id}.jsonl`),
      join(home, 'file-history', id), join(home, 'session-env', id), join(home, 'tasks', id),
      join(home, 'debug', `${id}.txt`), join(home, 'todos', `${id}-agent-${id}.json`), join(home, 'sessions', '100.json'),
      join(temporary, 'claude', 'f2f285784bd179bb', id),
    ]) expect(existsSync(gone), gone).toBe(false)
    for (const kept of [join(project, `${other}.jsonl`), join(home, 'todos', `${other}-agent-${other}.json`),
      join(home, 'sessions', '200.json'), memory])
      expect(existsSync(kept), kept).toBe(true)
    expect(readFileSync(join(home, 'history.jsonl'), 'utf8')).toBe(`${JSON.stringify({ display: `mentions ${id}`, sessionId: other })}\n`)
    expect(report.leftovers).toEqual([])
    expect(report.notes).toEqual([`Memory file ${memory} was written by this conversation and stays; check what it holds`])
    expect(report.erased).toContain(`1 line(s) of ${join(home, 'history.jsonl')}`)
  })

  it('touches nothing for an id that is not a UUID', async () => {
    write(join(home, 'projects', 'p', '...jsonl'))

    const report = await new ClaudeHistoryEraser({ homes: () => [home], temporaryRoot: temporary })
      .erase({ nativeSessionIds: ['..'], cwd: 'Q:\\work', since: 0 })

    expect(report.erased).toEqual([])
    expect(report.leftovers).toEqual(['Claude conversation "..": not a conversation id, so nothing was searched for it'])
    expect(existsSync(join(home, 'projects', 'p', '...jsonl'))).toBe(true)
  })
})
