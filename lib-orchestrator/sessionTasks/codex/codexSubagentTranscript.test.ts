import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { ProviderSubagentFileRef } from '../../projectManager/providerTranscriptView'
import { SessionTasks, type SessionTasksContext } from '../sessionTasks'
import type { SessionSubagentTranscript, SessionTaskParentState } from '../sessionTasksApi.types'
import { CodexSubagentTranscript } from './codexSubagentTranscript'
import { CodexChildFixtures } from './fixtures/codexChildFixtures'

describe('lib-orchestrator/sessionTasks/codex/codexSubagentTranscript', () => {
  const created: string[] = []
  const parentConst = CodexChildFixtures.parentThreadIdConst
  const childConst = CodexChildFixtures.firstChildIdConst
  const startedConst = new Date(2026, 9, 11, 20, 0, 0)
  const idleConst: SessionTaskParentState = { live: false, busy: false, now: startedConst.getTime() + 3_600_000 }
  const contextConst: SessionTasksContext = {
    agentId: 'codex',
    cwd: CodexChildFixtures.cwdConst,
    nativeSessionId: parentConst,
    startedAt: startedConst.getTime(),
  }

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  function childRef(content: string, nickname = 'Kuhn'): ProviderSubagentFileRef {
    const home = mkdtempSync(join(tmpdir(), 'jamat-codex-subagent-transcript-'))
    created.push(home)
    const file = CodexChildFixtures.write(home, startedConst, childConst, content)
    const stats = statSync(file)
    return {
      agentId: 'codex',
      subagentId: childConst,
      file,
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      metaFile: null,
      spawnKey: childConst,
      workflowId: null,
      thread: { nickname, depth: 1, parentSubagentId: null, startedAt: startedConst.getTime() },
    }
  }

  function tasksOver(refs: readonly ProviderSubagentFileRef[]): SessionTasks {
    return new SessionTasks({
      subagentFiles: () => Promise.resolve(refs),
      resolve: () => Promise.resolve(null),
      claudeShellOutputFile: () => Promise.resolve(null),
    })
  }

  function transcriptOf(answer: SessionSubagentTranscript): Extract<SessionSubagentTranscript, { kind: 'transcript' }> {
    if (answer.kind !== 'transcript') throw new Error(`Expected a transcript, got ${JSON.stringify(answer)}`)
    return answer
  }

  it('maps the task, the command, the applied patch and the final message in order, with model and tokens', async () => {
    const ref = childRef(CodexChildFixtures.workedChild(childConst, parentConst, 'Kuhn'))

    const answer = transcriptOf(await tasksOver([ref]).transcript(contextConst, childConst, idleConst, null))

    expect(answer.revision).toBe(`${ref.mtimeMs}:${ref.size}`)
    expect(answer.earlierStepsOmitted).toBe(false)
    expect(answer.header).toEqual({
      agentType: 'Kuhn',
      description: 'List the files in docs/architecture and report back.',
      model: 'gpt-6-astra',
      state: 'done',
      contextTokens: 25_164,
    })
    expect(answer.entries).toEqual([
      { kind: 'prompt', text: 'List the files in docs/architecture and report back.\nKeep it short.', truncated: false },
      { kind: 'thinking', at: Date.parse('2026-10-11T18:14:05.000Z') },
      {
        kind: 'tool',
        tool: 'exec',
        summary: 'Get-ChildItem docs/architecture',
        output: 'Mode  Name\n-a--  layout.md',
        outputTruncated: false,
        failed: false,
        at: Date.parse('2026-10-11T18:14:06.000Z'),
      },
      {
        kind: 'edit',
        path: 'C:\\work\\Plugins\\docs\\index.md',
        added: 2,
        removed: 1,
        preview: ' # Index\n-old line\n+new line\n+added line',
        at: Date.parse('2026-10-11T18:14:06.500Z'),
      },
      {
        kind: 'edit',
        path: 'C:\\work\\Plugins\\docs\\new.md',
        added: 2,
        removed: 0,
        preview: '+one\n+two',
        at: Date.parse('2026-10-11T18:14:06.500Z'),
      },
      { kind: 'message', role: 'assistant', text: 'Twelve files.', truncated: false, at: Date.parse('2026-10-11T18:14:07.000Z') },
    ])
  })

  it('shows an encrypted parent-to-child task as one encrypted entry and describes the child by its nickname', async () => {
    const ref = childRef(CodexChildFixtures.encryptedChild(childConst, parentConst, 'Jason'), 'Jason')

    const answer = transcriptOf(await tasksOver([ref]).transcript(contextConst, childConst, idleConst, null))

    expect(answer.entries).toEqual([{ kind: 'encrypted', at: Date.parse('2026-10-11T18:20:00.400Z') }])
    expect(answer.header).toMatchObject({ agentType: 'Jason', description: 'Jason', model: 'gpt-6-astra', state: 'done' })
  })

  it('reads a 3 MiB child from its tail, says earlier steps are left out and still finds the task in the head', async () => {
    const output = 'x'.repeat(8_000)
    const steps = Array.from({ length: 400 }, (_, index) =>
      CodexChildFixtures.commandDone(`Get-Content part-${index}.md`, '2026-10-11T18:15:00.000Z', output))
    const ref = childRef([
      CodexChildFixtures.header(childConst, parentConst, 'Kuhn', '2026-10-11T18:14:03.946Z'),
      CodexChildFixtures.taskStarted('2026-10-11T18:14:04.060Z'),
      CodexChildFixtures.turnContext('gpt-6-astra', '2026-10-11T18:14:04.120Z'),
      CodexChildFixtures.plainTask('Read every part.', '2026-10-11T18:14:04.150Z'),
      ...steps,
      CodexChildFixtures.assistantText('Read 400 parts.', '2026-10-11T18:16:00.000Z'),
      CodexChildFixtures.taskComplete('2026-10-11T18:16:01.000Z'),
    ].join(''))
    expect(ref.size).toBeGreaterThan(3 * 1_048_576)

    const answer = transcriptOf(await tasksOver([ref]).transcript(contextConst, childConst, idleConst, null))

    expect(answer.earlierStepsOmitted).toBe(true)
    expect(answer.entries[0]).toEqual({ kind: 'prompt', text: 'Read every part.', truncated: false })
    expect(answer.entries.filter((entry) => entry.kind === 'prompt')).toHaveLength(1)
    expect(answer.entries.filter((entry) => entry.kind === 'tool').length).toBeLessThan(400)
    expect(answer.entries.at(-1)).toMatchObject({ kind: 'message', text: 'Read 400 parts.' })
    expect(answer.header).toMatchObject({ description: 'Read every part.', model: 'gpt-6-astra', state: 'done' })
  })

  it('reads a file a little over the tail whole, so the task is neither lost nor read twice', async () => {
    const steps = Array.from({ length: 220 }, (_, index) =>
      CodexChildFixtures.commandDone(`Get-Content part-${index}.md`, '2026-10-11T18:15:00.000Z', 'y'.repeat(10_000)))
    const ref = childRef([
      CodexChildFixtures.header(childConst, parentConst, 'Kuhn', '2026-10-11T18:14:03.946Z'),
      CodexChildFixtures.plainTask('Read every part.', '2026-10-11T18:14:04.150Z'),
      ...steps,
    ].join(''))
    expect(ref.size).toBeGreaterThan(2_097_152)
    expect(ref.size).toBeLessThan(2_097_152 + CodexSubagentTranscript.headBytesConst)

    const answer = transcriptOf(await tasksOver([ref]).transcript(contextConst, childConst, idleConst, null))

    expect(answer.earlierStepsOmitted).toBe(false)
    expect(answer.entries.filter((entry) => entry.kind === 'prompt')).toHaveLength(1)
    expect(answer.entries.filter((entry) => entry.kind === 'tool')).toHaveLength(220)
  })

  it('maps a failed command, an old applied patch, the child\'s messages, a paired tool call and an interrupt', async () => {
    const lines = [
      CodexChildFixtures.header(childConst, parentConst, 'Kuhn', '2026-10-11T18:14:03.946Z'),
      CodexChildFixtures.plainTask('Fix it.', '2026-10-11T18:14:04.000Z'),
      CodexChildFixtures.commandDone('pnpm test', '2026-10-11T18:14:05.000Z', '1 failed', 1),
      CodexChildFixtures.patchApplyEnd({ 'a.ts': { type: 'update', unified_diff: '@@ -1 +1 @@\n-a\n+b\n' } }, false, '2026-10-11T18:14:06.000Z'),
      CodexChildFixtures.patchApplyEnd({ 'b.ts': { type: 'delete', content: 'gone\n' } }, true, '2026-10-11T18:14:07.000Z'),
      JSON.stringify({
        timestamp: '2026-10-11T18:14:08.000Z',
        type: 'response_item',
        payload: { type: 'function_call', name: 'wait_agent', arguments: '{"timeout_ms":1000,"target":"/root/x"}', call_id: 'w1' },
      }),
      JSON.stringify({
        timestamp: '2026-10-11T18:14:09.000Z',
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'w1', output: 'timed out' },
      }),
      CodexChildFixtures.sendMessage('Plain report.', '2026-10-11T18:14:10.000Z'),
      CodexChildFixtures.sendMessage('gAAAAABqzLRR7iew2zOm', '2026-10-11T18:14:11.000Z'),
      CodexChildFixtures.turnAborted('interrupted', '2026-10-11T18:14:12.000Z'),
    ].map((line) => line.endsWith('\n') ? line : `${line}\n`)
    const ref = childRef(lines.join(''))

    const answer = transcriptOf(await tasksOver([ref]).transcript(contextConst, childConst, idleConst, null))

    expect(answer.header.state).toBe('stopped')
    expect(answer.entries.map((entry) => entry.kind)).toEqual(['prompt', 'tool', 'edit', 'tool', 'message', 'encrypted', 'interrupted'])
    expect(answer.entries[1]).toMatchObject({ tool: 'exec', summary: 'pnpm test', output: '1 failed', failed: true })
    expect(answer.entries[2]).toMatchObject({ path: 'b.ts', added: 0, removed: 1 })
    expect(answer.entries[3]).toMatchObject({ tool: 'wait_agent', summary: '/root/x', output: 'timed out', failed: false })
    expect(answer.entries[4]).toMatchObject({ role: 'assistant', text: 'Plain report.' })
  })

  it('answers unchanged for the current revision and reads again after the file moved', async () => {
    const ref = childRef(CodexChildFixtures.workedChild(childConst, parentConst, 'Kuhn'))
    const reader = new CodexSubagentTranscript()

    expect(await reader.read(ref, idleConst, `${ref.mtimeMs}:${ref.size}`))
      .toEqual({ kind: 'unchanged', revision: `${ref.mtimeMs}:${ref.size}` })
    const moved = transcriptOf(await reader.read({ ...ref, mtimeMs: ref.mtimeMs + 1 }, idleConst, `${ref.mtimeMs}:${ref.size}`))
    expect(moved.revision).toBe(`${ref.mtimeMs + 1}:${ref.size}`)
  })

  it('reads no Codex transcript without the session start, and none for an id outside the listing', async () => {
    const ref = childRef(CodexChildFixtures.workedChild(childConst, parentConst, 'Kuhn'))
    const tasks = tasksOver([ref])

    expect(await tasks.transcript({ ...contextConst, startedAt: undefined }, childConst, idleConst, null))
      .toMatchObject({ kind: 'none', code: 'unreadable' })
    expect(await tasks.transcript(contextConst, CodexChildFixtures.strangerIdConst, idleConst, null))
      .toMatchObject({ kind: 'none', code: 'unknown-task' })
  })
})
