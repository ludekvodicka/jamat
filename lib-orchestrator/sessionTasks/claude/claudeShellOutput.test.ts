import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ProviderTranscriptRef } from '../../projectManager/providerTranscriptView'
import { SessionTasks } from '../sessionTasks'
import type { SessionShellRow, SessionTaskParentState } from '../sessionTasksApi.types'
import { ClaudeShellOutput } from './claudeShellOutput'
import { ClaudeShellFixtures } from './fixtures/claudeShellFixtures'

describe('lib-orchestrator/sessionTasks/claude/claudeShellOutput', () => {
  const created: string[] = []
  const liveConst: SessionTaskParentState = { live: true, busy: true, now: Date.parse('2026-10-02T07:00:00.000Z') }
  const rowConst: SessionShellRow = {
    kind: 'shell', shellId: 'b1', command: 'ping -n 30 127.0.0.1', description: null,
    state: 'running', startedAt: 1, endedAt: null,
  }

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  function file(name: string, content: string | Buffer): { file: string; mtimeMs: number; size: number } {
    const directory = mkdtempSync(join(tmpdir(), 'jamat-shell-output-'))
    created.push(directory)
    const path = join(directory, name)
    writeFileSync(path, content)
    const stats = statSync(path)
    return { file: path, mtimeMs: stats.mtimeMs, size: stats.size }
  }

  it('answers a small output whole, with the command and state of the row', async () => {
    const output = file('b1.output', 'Pinging 127.0.0.1\r\nReply from 127.0.0.1: time<1ms\r\n')

    expect(await ClaudeShellOutput.read(output, rowConst, null)).toEqual({
      kind: 'output',
      revision: `${output.mtimeMs}:${output.size}:running`,
      command: 'ping -n 30 127.0.0.1',
      state: 'running',
      startedAt: 1,
      endedAt: null,
      text: 'Pinging 127.0.0.1\r\nReply from 127.0.0.1: time<1ms\r\n',
      earlierOutputOmitted: false,
    })
  })

  it('answers the 64 KiB tail of a larger output and says earlier output is left out', async () => {
    const line = `${'x'.repeat(99)}\n`
    const output = file('b1.output', `FIRST\n${line.repeat(1_000)}LAST\n`)

    const reading = await ClaudeShellOutput.read(output, rowConst, null)

    if (reading.kind !== 'output') throw new Error(`Expected output, got ${reading.kind}`)
    expect(reading.earlierOutputOmitted).toBe(true)
    expect(Buffer.byteLength(reading.text)).toBeLessThanOrEqual(ClaudeShellOutput.tailBytesConst)
    expect(reading.text.startsWith('x')).toBe(true)
    expect(reading.text.endsWith(`${line}LAST\n`)).toBe(true)
    expect(reading.text).not.toContain('FIRST')
  })

  it('removes colour and title sequences and keeps every other byte', () => {
    expect(ClaudeShellOutput.plainOf('\u001b[31mred\u001b[0m \u001b[1;32mok\u001b[m\u009b2K done'))
      .toBe('red ok done')
    expect(ClaudeShellOutput.plainOf('\u001b]0;title\u0007a\u001b]8;;https://x\u001b\\link\u001b]8;;\u001b\\ b'))
      .toBe('alink b')
    const plain = 'tab\there, "quotes", <b>tags</b>, ünïcode ✓, [31m without escape\r\n'
    expect(ClaudeShellOutput.plainOf(plain)).toBe(plain)
  })

  it('answers unchanged for the known revision and reads again once the state moved', async () => {
    const output = file('b1.output', 'line\n')
    const revision = ClaudeShellOutput.revisionOf(output, rowConst)

    expect(await ClaudeShellOutput.read(output, rowConst, revision)).toEqual({ kind: 'unchanged', revision })
    expect(await ClaudeShellOutput.read(output, { ...rowConst, state: 'done' }, revision))
      .toEqual(expect.objectContaining({ kind: 'output', state: 'done', text: 'line\n' }))
  })

  describe('SessionTasks.shellOutput', () => {
    function parentRef(content: string): ProviderTranscriptRef {
      const transcript = file(`${ClaudeShellFixtures.sessionIdConst}.jsonl`, content)
      return { agentId: 'claude', nativeSessionId: ClaudeShellFixtures.sessionIdConst, ...transcript }
    }

    const contextConst = { agentId: 'claude' as const, cwd: 'Q:/Work/App', nativeSessionId: ClaudeShellFixtures.sessionIdConst }

    it('finds the shell in the scan and reads the file the view resolves, with the stated path', async () => {
      const ref = parentRef(
        ClaudeShellFixtures.bashUse('toolu_1', { command: 'ping -n 30 127.0.0.1' }, '2026-10-02T06:00:00.000Z')
        + ClaudeShellFixtures.launch('toolu_1', 'b1', '2026-10-02T06:00:01.000Z'),
      )
      const output = file('b1.output', '\u001b[32mReply\u001b[0m\n')
      const claudeShellOutputFile = vi.fn(() => Promise.resolve(output))
      const tasks = new SessionTasks({ subagentFiles: () => Promise.resolve([]), resolve: () => Promise.resolve(ref), claudeShellOutputFile })

      const reading = await tasks.shellOutput(contextConst, 'b1', liveConst, null)

      expect(reading).toEqual(expect.objectContaining({ kind: 'output', command: 'ping -n 30 127.0.0.1', state: 'running', text: 'Reply\n' }))
      expect(claudeShellOutputFile).toHaveBeenCalledWith({
        cwd: 'Q:/Work/App',
        nativeSessionId: ClaudeShellFixtures.sessionIdConst,
        shellId: 'b1',
        statedPath: `${ClaudeShellFixtures.outputRootConst}\\b1.output`,
      })
    })

    it('carries the end the transcript states', async () => {
      const ref = parentRef(
        ClaudeShellFixtures.bashUse('toolu_1', { command: 'pnpm test' }, '2026-10-02T06:00:00.000Z')
        + ClaudeShellFixtures.launch('toolu_1', 'b1', '2026-10-02T06:00:01.000Z')
        + ClaudeShellFixtures.notification('b1', 'killed', '2026-10-02T06:01:00.000Z'),
      )
      const output = file('b1.output', 'partial\n')
      const tasks = new SessionTasks({ subagentFiles: () => Promise.resolve([]), resolve: () => Promise.resolve(ref),
        claudeShellOutputFile: () => Promise.resolve(output) })

      expect(await tasks.shellOutput(contextConst, 'b1', liveConst, null))
        .toEqual(expect.objectContaining({ kind: 'output', state: 'killed' }))
    })

    it('answers unknown-task for a shell the scan never saw and for a sub-agent id, reading no file', async () => {
      const ref = parentRef(ClaudeShellFixtures.notification('a1', 'completed', '2026-10-02T06:01:00.000Z'))
      const claudeShellOutputFile = vi.fn(() => Promise.resolve(null))
      const tasks = new SessionTasks({ subagentFiles: () => Promise.resolve([]), resolve: () => Promise.resolve(ref), claudeShellOutputFile })

      expect(await tasks.shellOutput(contextConst, 'b9', liveConst, null)).toEqual(expect.objectContaining({ kind: 'none', code: 'unknown-task' }))
      expect(await tasks.shellOutput(contextConst, 'a1', liveConst, null)).toEqual(expect.objectContaining({ kind: 'none', code: 'unknown-task' }))
      expect(await tasks.shellOutput(contextConst, '../b1', liveConst, null)).toEqual(expect.objectContaining({ kind: 'none', code: 'unknown-task' }))
      expect(claudeShellOutputFile).not.toHaveBeenCalled()
    })

    it('follows a running shell whose file does not exist yet and says a settled one is gone', async () => {
      const ref = parentRef(
        ClaudeShellFixtures.bashUse('toolu_1', { command: 'pnpm test' }, '2026-10-02T06:00:00.000Z')
        + ClaudeShellFixtures.launch('toolu_1', 'b1', '2026-10-02T06:00:01.000Z'),
      )
      const tasks = new SessionTasks({ subagentFiles: () => Promise.resolve([]), resolve: () => Promise.resolve(ref),
        claudeShellOutputFile: () => Promise.resolve(null) })

      const first = await tasks.shellOutput(contextConst, 'b1', liveConst, null)
      expect(first).toEqual(expect.objectContaining({ kind: 'output', text: '', state: 'running' }))
      if (first.kind !== 'output') throw new Error('Expected output')
      expect(await tasks.shellOutput(contextConst, 'b1', liveConst, first.revision)).toEqual({ kind: 'unchanged', revision: first.revision })
      expect(await tasks.shellOutput(contextConst, 'b1', { ...liveConst, live: false }, null))
        .toEqual(expect.objectContaining({ kind: 'none', code: 'unreadable' }))
    })

    it('reads no shell of a Codex session', async () => {
      const resolve = vi.fn(() => Promise.resolve(null))
      const tasks = new SessionTasks({ subagentFiles: () => Promise.resolve([]), resolve, claudeShellOutputFile: () => Promise.resolve(null) })

      expect(await tasks.shellOutput({ ...contextConst, agentId: 'codex', startedAt: 1 }, 'b1', liveConst, null))
        .toEqual(expect.objectContaining({ kind: 'none', code: 'unknown-task' }))
      expect(resolve).not.toHaveBeenCalled()
    })
  })
})
