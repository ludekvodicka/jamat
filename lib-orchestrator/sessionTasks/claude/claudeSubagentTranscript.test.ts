import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ProviderSubagentFileRef } from '../../projectManager/providerTranscriptView'
import { FileTail } from '../../shared/fileTail'
import { SessionTasks, type SessionTasksContext } from '../sessionTasks'
import type { SessionSubagentTranscript, SessionTaskParentState } from '../sessionTasksApi.types'
import { ClaudeSubagentTranscript } from './claudeSubagentTranscript'
import { ClaudeSubagentFixtures } from './fixtures/claudeSubagentFixtures'

describe('lib-orchestrator/sessionTasks/claude/claudeSubagentTranscript', () => {
  const created: string[] = []
  const nowConst = Date.parse('2026-10-12T07:00:00.000Z')
  const idleConst: SessionTaskParentState = { live: false, busy: false, now: nowConst }
  const contextConst: SessionTasksContext = { agentId: 'claude', cwd: 'C:/work', nativeSessionId: 'native-1' }

  afterEach(() => {
    vi.restoreAllMocks()
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  function agentFile(
    subagentId: string,
    content: string,
    meta: Record<string, unknown> | null = null,
  ): ProviderSubagentFileRef {
    const root = mkdtempSync(join(tmpdir(), 'jamat-subagent-transcript-'))
    created.push(root)
    const file = join(root, `agent-${subagentId}.jsonl`)
    writeFileSync(file, content, 'utf8')
    let metaFile: string | null = null
    if (meta !== null) {
      metaFile = join(root, `agent-${subagentId}.meta.json`)
      writeFileSync(metaFile, JSON.stringify(meta), 'utf8')
    }
    const stats = statSync(file)
    return {
      agentId: 'claude',
      subagentId,
      file,
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      metaFile,
      spawnKey: null,
      workflowId: null,
      thread: null,
    }
  }

  function tasksOver(refs: readonly ProviderSubagentFileRef[]): { tasks: SessionTasks; listings: () => number } {
    let listings = 0
    const tasks = new SessionTasks({
      subagentFiles: () => {
        listings += 1
        return Promise.resolve(refs)
      },
      resolve: () => Promise.resolve(null),
      claudeShellOutputFile: () => Promise.resolve(null),
    })
    return { tasks, listings: () => listings }
  }

  function transcriptOf(answer: SessionSubagentTranscript): Extract<SessionSubagentTranscript, { kind: 'transcript' }> {
    if (answer.kind !== 'transcript') throw new Error(`Expected a transcript, got ${JSON.stringify(answer)}`)
    return answer
  }

  const editPatchConst = {
    filePath: 'Q:/work/app/x.ts',
    structuredPatch: [{
      oldStart: 3,
      oldLines: 2,
      newStart: 3,
      newLines: 3,
      lines: [' const a = 1', '-const b = 2', '+const b = 3', '+const c = 4'],
    }],
  }

  it('maps prompt, tool calls, a confirmed edit and the final text in order, with the edit counts', async () => {
    const ref = agentFile('a1', [
      ClaudeSubagentFixtures.prompt('Find the reader.\nThen report.', '2026-10-12T06:00:00.000Z'),
      ClaudeSubagentFixtures.attachment(),
      ClaudeSubagentFixtures.thinking('2026-10-12T06:00:01.000Z'),
      ClaudeSubagentFixtures.thinking('2026-10-12T06:00:01.500Z'),
      ClaudeSubagentFixtures.toolCall('t1', 'Bash', { command: 'pnpm test\n--run', description: 'Run tests' }),
      ClaudeSubagentFixtures.toolOutcome('t1', 'all green'),
      ClaudeSubagentFixtures.toolCall('t2', 'Read', { file_path: 'Q:/work/docs/x.md' }),
      ClaudeSubagentFixtures.toolOutcome('t2', '1\t# X'),
      ClaudeSubagentFixtures.toolCall('t3', 'Edit', {
        file_path: 'Q:/work/app/x.ts',
        old_string: 'const b = 2',
        new_string: 'const b = 3\nconst c = 4',
      }, '2026-10-12T06:00:05.000Z'),
      ClaudeSubagentFixtures.toolOutcome('t3', 'The file was updated.', { toolUseResult: editPatchConst }),
      ClaudeSubagentFixtures.finalText('Done: the reader is in x.ts.', '2026-10-12T06:00:06.000Z'),
    ].join(''), { agentType: 'Explore', description: 'Find the reader', model: 'inherit' })

    const answer = transcriptOf(await tasksOver([ref]).tasks.transcript(contextConst, 'a1', idleConst, null))

    expect(answer.revision).toBe(`${ref.mtimeMs}:${ref.size}`)
    expect(answer.earlierStepsOmitted).toBe(false)
    expect(answer.header).toEqual({
      agentType: 'Explore',
      description: 'Find the reader',
      model: 'claude-opus-5-5',
      state: 'done',
      contextTokens: 31_203,
    })
    expect(answer.entries).toEqual([
      { kind: 'prompt', text: 'Find the reader.\nThen report.', truncated: false },
      { kind: 'thinking', at: Date.parse('2026-10-12T06:00:01.000Z') },
      {
        kind: 'tool',
        tool: 'Bash',
        summary: 'pnpm test --run',
        output: 'all green',
        outputTruncated: false,
        failed: false,
        at: Date.parse('2026-10-12T06:00:03.000Z'),
      },
      {
        kind: 'tool',
        tool: 'Read',
        summary: 'Q:/work/docs/x.md',
        output: '1\t# X',
        outputTruncated: false,
        failed: false,
        at: Date.parse('2026-10-12T06:00:03.000Z'),
      },
      {
        kind: 'edit',
        path: 'Q:/work/app/x.ts',
        added: 2,
        removed: 1,
        preview: ' const a = 1\n-const b = 2\n+const b = 3\n+const c = 4',
        at: Date.parse('2026-10-12T06:00:05.000Z'),
      },
      {
        kind: 'message',
        role: 'assistant',
        text: 'Done: the reader is in x.ts.',
        truncated: false,
        at: Date.parse('2026-10-12T06:00:06.000Z'),
      },
    ])
  })

  it('keeps a failed Edit as a failed tool entry and never as an edit', async () => {
    const ref = agentFile('a2', [
      ClaudeSubagentFixtures.prompt('Edit it.'),
      ClaudeSubagentFixtures.toolCall('t1', 'Edit', { file_path: 'Q:/work/app/x.ts', old_string: 'a', new_string: 'b' }),
      ClaudeSubagentFixtures.toolOutcome('t1', 'String to replace not found in file.', { isError: true }),
    ].join(''))

    const answer = transcriptOf(await tasksOver([ref]).tasks.transcript(contextConst, 'a2', idleConst, null))

    expect(answer.entries.slice(1)).toEqual([{
      kind: 'tool',
      tool: 'Edit',
      summary: 'Q:/work/app/x.ts',
      output: 'String to replace not found in file.',
      outputTruncated: false,
      failed: true,
      at: Date.parse('2026-10-12T06:00:03.000Z'),
    }])
    expect(answer.header.state).toBe('unfinished')
  })

  it('counts a Write and an Edit without a recorded patch from their own input', async () => {
    const ref = agentFile('a3', [
      ClaudeSubagentFixtures.prompt('Write it.'),
      ClaudeSubagentFixtures.toolCall('t1', 'Write', { file_path: 'Q:/work/new.ts', content: 'one\ntwo\nthree\n' }),
      ClaudeSubagentFixtures.toolOutcome('t1', 'File created'),
      ClaudeSubagentFixtures.toolCall('t2', 'Edit', { file_path: 'Q:/work/new.ts', old_string: 'one\ntwo', new_string: 'uno' }),
      ClaudeSubagentFixtures.toolOutcome('t2', 'The file was updated.'),
      ClaudeSubagentFixtures.toolCall('t3', 'Edit', { file_path: 'Q:/work/new.ts', old_string: 'x', new_string: 'y' }),
    ].join(''))

    const answer = transcriptOf(await tasksOver([ref]).tasks.transcript(contextConst, 'a3', idleConst, null))

    expect(answer.entries.slice(1).map((entry) => entry.kind === 'edit'
      ? [entry.kind, entry.added, entry.removed, entry.preview]
      : [entry.kind])).toEqual([
      ['edit', 3, 0, '+one\n+two\n+three'],
      ['edit', 1, 2, '-one\n-two\n+uno'],
      // Not confirmed yet: a call, until its result arrives.
      ['tool'],
    ])
  })

  it('maps compaction, a coordinator message, an interrupt and an API error, skipping the compact summary', async () => {
    const ref = agentFile('a4', [
      ClaudeSubagentFixtures.prompt('Work.'),
      ClaudeSubagentFixtures.compactBoundary('2026-10-12T06:00:08.000Z'),
      ClaudeSubagentFixtures.compactSummary(),
      ClaudeSubagentFixtures.queuedCommand('Note from the lead: keep the tab name.', '2026-10-12T06:00:10.000Z'),
      ClaudeSubagentFixtures.apiError('2026-10-12T06:00:11.000Z'),
      ClaudeSubagentFixtures.interrupted('[Request interrupted by user]', '2026-10-12T06:00:12.000Z'),
    ].join(''))

    const answer = transcriptOf(await tasksOver([ref]).tasks.transcript(contextConst, 'a4', idleConst, null))

    expect(answer.entries.slice(1)).toEqual([
      { kind: 'compact', at: Date.parse('2026-10-12T06:00:08.000Z') },
      {
        kind: 'message',
        role: 'user',
        text: 'Note from the lead: keep the tab name.',
        truncated: false,
        at: Date.parse('2026-10-12T06:00:10.000Z'),
      },
      { kind: 'error', text: 'You\'ve hit your session limit', at: Date.parse('2026-10-12T06:00:11.000Z') },
      { kind: 'interrupted', at: Date.parse('2026-10-12T06:00:12.000Z') },
    ])
    expect(answer.header.state).toBe('stopped')
  })

  it('cuts text over 4,000 characters and tool output over 2,000', async () => {
    const ref = agentFile('a5', [
      ClaudeSubagentFixtures.prompt('p'.repeat(4_100)),
      ClaudeSubagentFixtures.toolCall('t1', 'Bash', { command: 'cat big' }),
      ClaudeSubagentFixtures.toolOutcome('t1', 'o'.repeat(2_100)),
      ClaudeSubagentFixtures.finalText('m'.repeat(4_001)),
    ].join(''))

    const answer = transcriptOf(await tasksOver([ref]).tasks.transcript(contextConst, 'a5', idleConst, null))

    expect(answer.entries[0]).toEqual({ kind: 'prompt', text: 'p'.repeat(4_000), truncated: true })
    expect(answer.entries[1]).toMatchObject({ kind: 'tool', output: 'o'.repeat(2_000), outputTruncated: true })
    expect(answer.entries[2]).toMatchObject({ kind: 'message', text: 'm'.repeat(4_000), truncated: true })
  })

  it('reads a 3 MiB file as its prompt from the head and its last steps from the tail', async () => {
    const steps: string[] = []
    let size = 0
    for (let index = 0; size < 3 * 1_048_576; index += 1) {
      const call = ClaudeSubagentFixtures.toolCall(`t${index}`, 'Bash', { command: `step ${index}` })
      const outcome = ClaudeSubagentFixtures.toolOutcome(`t${index}`, 'x'.repeat(16_000))
      steps.push(call, outcome)
      size += call.length + outcome.length
    }
    const ref = agentFile('a6', [
      ClaudeSubagentFixtures.prompt('Survey every reader.'),
      ...steps,
      ClaudeSubagentFixtures.finalText('Surveyed.'),
    ].join(''))

    const answer = transcriptOf(await tasksOver([ref]).tasks.transcript(contextConst, 'a6', idleConst, null))

    expect(answer.earlierStepsOmitted).toBe(true)
    expect(answer.entries[0]).toEqual({ kind: 'prompt', text: 'Survey every reader.', truncated: false })
    expect(answer.entries.at(-1)).toMatchObject({ kind: 'message', text: 'Surveyed.' })
    expect(answer.entries.some((entry) => entry.kind === 'tool' && entry.summary === 'step 0')).toBe(false)
    expect(answer.header.description).toBe('Survey every reader.')
    expect(answer.header.state).toBe('done')
  })

  it('takes the start of a prompt longer than the head as a cut prompt', async () => {
    const ref = agentFile('a7', [
      ClaudeSubagentFixtures.prompt(`Start here.\n${'q'.repeat(70_000)}`),
      ClaudeSubagentFixtures.toolCall('t0', 'Bash', { command: 'ls' }),
      ClaudeSubagentFixtures.toolOutcome('t0', 'y'.repeat(2_200_000)),
      ClaudeSubagentFixtures.finalText('Listed.'),
    ].join(''))

    const answer = transcriptOf(await tasksOver([ref]).tasks.transcript(contextConst, 'a7', idleConst, null))

    expect(answer.earlierStepsOmitted).toBe(true)
    expect(answer.entries[0]).toEqual({ kind: 'prompt', text: `Start here.\n${'q'.repeat(3_988)}`, truncated: true })
    expect(answer.header.description).toBe('Start here.')
  })

  it('answers unchanged for the known revision after one listing and no read', async () => {
    const ref = agentFile('a8', ClaudeSubagentFixtures.realAgent())
    const { tasks, listings } = tasksOver([ref])
    const read = vi.spyOn(FileTail, 'readBounded')

    expect(await tasks.transcript(contextConst, 'a8', idleConst, `${ref.mtimeMs}:${ref.size}`))
      .toEqual({ kind: 'unchanged', revision: `${ref.mtimeMs}:${ref.size}` })
    expect(listings()).toBe(1)
    expect(read).not.toHaveBeenCalled()
  })

  it('reads a revision once and composes the state per call from the cache', async () => {
    const ref = agentFile('a9', [
      ClaudeSubagentFixtures.prompt('Work.'),
      ClaudeSubagentFixtures.toolCall('t1', 'Bash', { command: 'pnpm test' }),
    ].join(''))
    const { tasks } = tasksOver([ref])
    const read = vi.spyOn(FileTail, 'readBounded')

    const first = transcriptOf(await tasks.transcript(contextConst, 'a9', { live: true, busy: true, now: nowConst }, 'old'))
    const second = transcriptOf(await tasks.transcript(contextConst, 'a9', idleConst, null))

    expect([first.header.state, second.header.state]).toEqual(['running', 'unfinished'])
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('answers unknown-task for an id that is not in the session listing, and reads no path', async () => {
    const ref = agentFile('a10', ClaudeSubagentFixtures.realAgent())
    const { tasks } = tasksOver([ref])

    expect(await tasks.transcript(contextConst, 'other', idleConst, null)).toEqual({
      kind: 'none',
      code: 'unknown-task',
      reason: 'the session has no sub-agent other',
    })
    expect(await tasks.transcript(contextConst, '../a10', idleConst, null)).toMatchObject({
      kind: 'none',
      code: 'unknown-task',
    })
  })

  it('answers unreadable when the listed file vanished before the read', async () => {
    const ref = agentFile('a11', ClaudeSubagentFixtures.realAgent())
    rmSync(ref.file)

    expect(await new ClaudeSubagentTranscript().read(ref, idleConst, null)).toMatchObject({
      kind: 'none',
      code: 'unreadable',
    })
  })

  it('reads the agent cut from a real session', async () => {
    const ref = agentFile(
      ClaudeSubagentFixtures.realAgentIdConst,
      ClaudeSubagentFixtures.realAgent(),
      ClaudeSubagentFixtures.realAgentMetaConst,
    )

    const answer = transcriptOf(await new ClaudeSubagentTranscript().read(ref, idleConst, null))

    expect(answer.header).toMatchObject({
      agentType: 'pp:research:repo-research-analyst',
      description: 'Jamat transcript readers research',
      state: 'done',
    })
    expect(answer.entries.map((entry) => entry.kind)).toEqual(['prompt', 'thinking', 'tool', 'thinking', 'message'])
    expect(answer.entries[2]).toMatchObject({ tool: 'Bash', output: '     1\timport type {' })
  })
})
