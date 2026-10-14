import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { ProviderTranscriptRef } from '../../projectManager/providerTranscriptView'
import type { SessionTaskParentState } from '../sessionTasksApi.types'
import { ClaudeShellScan } from './claudeShellScan'
import { ClaudeShellFixtures } from './fixtures/claudeShellFixtures'

describe('lib-orchestrator/sessionTasks/claude/claudeShellScan', () => {
  const created: string[] = []
  const liveConst: SessionTaskParentState = { live: true, busy: false, now: Date.parse('2026-10-02T07:00:00.000Z') }
  const endedConst: SessionTaskParentState = { ...liveConst, live: false }

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  function transcript(content: string): string {
    const directory = mkdtempSync(join(tmpdir(), 'jamat-shell-scan-'))
    created.push(directory)
    const file = join(directory, `${ClaudeShellFixtures.sessionIdConst}.jsonl`)
    writeFileSync(file, content, 'utf8')
    return file
  }

  function refOf(file: string): ProviderTranscriptRef {
    const stats = statSync(file)
    return { agentId: 'claude', nativeSessionId: ClaudeShellFixtures.sessionIdConst, file, mtimeMs: stats.mtimeMs, size: stats.size }
  }

  async function rowsOf(scan: ClaudeShellScan, file: string, parent = liveConst) {
    const reading = await scan.scan(refOf(file))
    return reading.shells.map((facts) => ClaudeShellScan.rowOf(facts, parent))
  }

  it('reads both shells of the real cut as done, each with its command, description and end', async () => {
    const scan = new ClaudeShellScan()
    const file = transcript(ClaudeShellFixtures.realShells())

    const reading = await scan.scan(refOf(file))

    expect(reading.catchingUp).toBe(false)
    expect(reading.shells.map((facts) => ClaudeShellScan.rowOf(facts, liveConst))).toEqual([
      {
        kind: 'shell',
        shellId: 'b63xl0o9b',
        command: 'grep -rn "does not provide an export" skills app-client-cli',
        description: 'Find CLI wrapper and refusal message source',
        state: 'done',
        startedAt: Date.parse('2026-10-02T05:39:17.008Z'),
        endedAt: Date.parse('2026-10-02T05:39:26.684Z'),
      },
      {
        kind: 'shell',
        shellId: 'bk8euh7vf',
        command: 'bash ~/.claude/scripts/commit-svn.sh openwait "Q:/Work/App/skills"',
        description: 'Open Jamat SVN review and wait for result',
        state: 'done',
        startedAt: Date.parse('2026-10-02T06:13:03.546Z'),
        endedAt: Date.parse('2026-10-02T06:13:24.238Z'),
      },
    ])
    expect(reading.shells[1].statedOutput).toBe(`${ClaudeShellFixtures.outputRootConst}\\bk8euh7vf.output`)
  })

  it('takes a launch whose Bash call carries no run_in_background, as ctrl+b leaves it', async () => {
    const file = transcript(
      ClaudeShellFixtures.bashUse('toolu_1', { command: 'pnpm test' }, '2026-10-02T06:00:00.000Z')
      + ClaudeShellFixtures.launch('toolu_1', 'b1', '2026-10-02T06:00:30.000Z'),
    )

    expect(await rowsOf(new ClaudeShellScan(), file)).toEqual([expect.objectContaining({
      shellId: 'b1', command: 'pnpm test', description: null, state: 'running', endedAt: null,
    })])
  })

  it('lists a shell without an end as unfinished once its parent is gone', async () => {
    const file = transcript(
      ClaudeShellFixtures.bashUse('toolu_1', { command: 'pnpm test', run_in_background: true }, '2026-10-02T06:00:00.000Z')
      + ClaudeShellFixtures.launch('toolu_1', 'b1', '2026-10-02T06:00:01.000Z'),
    )

    expect((await rowsOf(new ClaudeShellScan(), file, endedConst)).map((row) => row.state)).toEqual(['unfinished'])
  })

  it('lists no row for a Monitor launch or for the notification of a shell it never saw launched', async () => {
    const file = transcript(
      ClaudeShellFixtures.monitorUse('toolu_m', '2026-10-02T06:00:00.000Z')
      + ClaudeShellFixtures.monitorLaunch('toolu_m', 'b525byw1f', '2026-10-02T06:00:01.000Z')
      + ClaudeShellFixtures.notification('b525byw1f', 'completed', '2026-10-02T06:00:05.000Z')
      + ClaudeShellFixtures.notification('bsub00001', 'completed', '2026-10-02T06:00:06.000Z'),
    )

    const reading = await new ClaudeShellScan().scan(refOf(file))

    expect(reading.shells).toEqual([])
    expect(reading.agentNotifications.size).toBe(0)
  })

  it('maps failed and killed, and lets a later notification of the same id win', async () => {
    const file = transcript(
      ClaudeShellFixtures.bashUse('toolu_1', { command: 'node -e "process.exit(3)"', run_in_background: true }, '2026-10-02T06:00:00.000Z')
      + ClaudeShellFixtures.launch('toolu_1', 'b1', '2026-10-02T06:00:01.000Z')
      + ClaudeShellFixtures.bashUse('toolu_2', { command: 'ping -n 300 127.0.0.1', run_in_background: true }, '2026-10-02T06:00:02.000Z')
      + ClaudeShellFixtures.launch('toolu_2', 'b2', '2026-10-02T06:00:03.000Z')
      + ClaudeShellFixtures.notification('b1', 'failed', '2026-10-02T06:00:04.000Z')
      + ClaudeShellFixtures.notification('b2', 'completed', '2026-10-02T06:00:05.000Z')
      + ClaudeShellFixtures.notification('b2', 'killed', '2026-10-02T06:00:06.000Z'),
    )

    expect((await rowsOf(new ClaudeShellScan(), file)).map((row) => [row.shellId, row.state, row.endedAt])).toEqual([
      ['b1', 'failed', Date.parse('2026-10-02T06:00:04.000Z')],
      ['b2', 'killed', Date.parse('2026-10-02T06:00:06.000Z')],
    ])
  })

  it('ends a shell and a sub-agent the agent stopped with TaskStop, which gets no notification', async () => {
    const command = 'node shared/electron/e2e/electronE2eRendererServer.ts out/renderer 47191'
    const file = transcript(
      ClaudeShellFixtures.bashUse('toolu_1', { command, run_in_background: true }, '2026-10-02T06:00:00.000Z')
      + ClaudeShellFixtures.launch('toolu_1', 'b2daiyykd', '2026-10-02T06:00:01.000Z')
      + ClaudeShellFixtures.bashUse('toolu_2', { command: 'pnpm dev', run_in_background: true }, '2026-10-02T06:00:02.000Z')
      + ClaudeShellFixtures.launch('toolu_2', 'b2', '2026-10-02T06:00:03.000Z')
      + ClaudeShellFixtures.taskStop('toolu_3', 'b2daiyykd', 'local_bash', command, '2026-10-02T06:00:04.000Z')
      + ClaudeShellFixtures.taskStopRefused('toolu_4', 'b2', '2026-10-02T06:00:05.000Z')
      + ClaudeShellFixtures.taskStop('toolu_5', 'a0f8bc8408b69da4e', 'local_agent', 'Review the plan', '2026-10-02T06:00:06.000Z'),
    )

    const scan = new ClaudeShellScan()
    expect((await rowsOf(scan, file)).map((row) => [row.shellId, row.state, row.endedAt])).toEqual([
      ['b2daiyykd', 'killed', Date.parse('2026-10-02T06:00:04.000Z')],
      ['b2', 'running', null],
    ])
    expect((await scan.scan(refOf(file))).agentNotifications.get('a0f8bc8408b69da4e')).toEqual({
      status: 'stopped', at: Date.parse('2026-10-02T06:00:06.000Z'),
    })
  })

  it('settles a short shell whose end notification is written before its launch record', async () => {
    const file = transcript(
      ClaudeShellFixtures.bashUse('toolu_1', { command: 'pnpm run dev > dev2.log', run_in_background: true }, '2026-10-02T06:00:00.000Z')
      + ClaudeShellFixtures.notification('bx6rf0pa7', 'completed', '2026-10-02T06:00:03.000Z')
      + ClaudeShellFixtures.launch('toolu_1', 'bx6rf0pa7', '2026-10-02T06:00:01.000Z'),
    )

    expect((await rowsOf(new ClaudeShellScan(), file)).map((row) => [row.shellId, row.state, row.endedAt])).toEqual([
      ['bx6rf0pa7', 'done', Date.parse('2026-10-02T06:00:03.000Z')],
    ])
  })

  it('keeps the latest notification of each sub-agent as its witness', async () => {
    const file = transcript(
      ClaudeShellFixtures.notification('a0f8bc8408b69da4e', 'completed', '2026-10-02T06:00:04.000Z')
      + ClaudeShellFixtures.notification('a0f8bc8408b69da4e', 'killed', '2026-10-02T06:00:09.000Z'),
    )

    const reading = await new ClaudeShellScan().scan(refOf(file))

    expect(reading.agentNotifications.get('a0f8bc8408b69da4e')).toEqual({
      status: 'killed', at: Date.parse('2026-10-02T06:00:09.000Z'),
    })
  })

  it('reads at most 4 MiB per call, keeps the cut last line and completes it on the next call', async () => {
    const head = ClaudeShellFixtures.bashUse('toolu_1', { command: 'pnpm build', run_in_background: true }, '2026-10-02T06:00:00.000Z')
    const launch = ClaudeShellFixtures.launch('toolu_1', 'b1', '2026-10-02T06:00:01.000Z')
    // The launch line straddles the 4 MiB mark.
    const filler = ClaudeShellFixtures.filler(ClaudeShellScan.maxBytesPerCallConst - Buffer.byteLength(head) - 100)
    const file = transcript(head + filler + launch + ClaudeShellFixtures.notification('b1', 'completed', '2026-10-02T06:00:09.000Z'))
    const scan = new ClaudeShellScan()

    const first = await scan.scan(refOf(file))
    expect(first.catchingUp).toBe(true)
    expect(first.shells).toEqual([])

    const second = await scan.scan(refOf(file))
    expect(second.catchingUp).toBe(false)
    expect(second.shells.map((facts) => ClaudeShellScan.rowOf(facts, liveConst))).toEqual([
      expect.objectContaining({ shellId: 'b1', command: 'pnpm build', state: 'done' }),
    ])
  })

  it('reads only what was appended, and an end that arrives later settles the shell', async () => {
    const file = transcript(
      ClaudeShellFixtures.bashUse('toolu_1', { command: 'ping -n 20 127.0.0.1', run_in_background: true }, '2026-10-02T06:00:00.000Z')
      + ClaudeShellFixtures.launch('toolu_1', 'b1', '2026-10-02T06:00:01.000Z'),
    )
    const scan = new ClaudeShellScan()
    expect((await rowsOf(scan, file)).map((row) => row.state)).toEqual(['running'])

    appendFileSync(file, ClaudeShellFixtures.notification('b1', 'completed', '2026-10-02T06:00:21.000Z'))

    expect((await rowsOf(scan, file)).map((row) => row.state)).toEqual(['done'])
  })

  it('starts again from zero when the file was cut or rewritten under it, with the same rows', async () => {
    const content = ClaudeShellFixtures.realShells()
    const file = transcript(content)
    const scan = new ClaudeShellScan()
    const before = await rowsOf(scan, file)

    writeFileSync(file, 'x'.repeat(10), 'utf8')
    expect(await rowsOf(scan, file)).toEqual([])
    writeFileSync(file, content, 'utf8')
    expect(await rowsOf(scan, file)).toEqual(before)

    // The history migrator rewrites in place: the bytes before the offset change, the size grows.
    writeFileSync(file, content.replaceAll('Q:/Work/App', 'Q:/Work/Application'), 'utf8')
    const rewritten = await rowsOf(scan, file)
    expect(rewritten.map((row) => [row.shellId, row.state])).toEqual(before.map((row) => [row.shellId, row.state]))
    expect(rewritten[1].command).toContain('Q:/Work/Application/skills')
  })

  it('keeps every running shell and the newest 50 finished ones, and counts the rest', async () => {
    const lines: string[] = []
    const at = (second: number): string => new Date(Date.parse('2026-10-02T06:00:00.000Z') + second * 1_000).toISOString()
    for (let index = 0; index < 120; index += 1) {
      lines.push(ClaudeShellFixtures.bashUse(`toolu_${index}`, { command: `echo ${index}` }, at(index * 3)))
      lines.push(ClaudeShellFixtures.launch(`toolu_${index}`, `b${index}`, at(index * 3 + 1)))
      lines.push(ClaudeShellFixtures.notification(`b${index}`, 'completed', at(index * 3 + 2)))
    }
    lines.push(ClaudeShellFixtures.bashUse('toolu_run', { command: 'sleep 600' }, at(1_000)))
    lines.push(ClaudeShellFixtures.launch('toolu_run', 'brun', at(1_001)))

    const reading = await new ClaudeShellScan().scan(refOf(transcript(lines.join(''))))

    expect(reading.shells).toHaveLength(51)
    expect(reading.olderFinished).toBe(70)
    expect(reading.shells.some((facts) => facts.shellId === 'brun' && facts.end === null)).toBe(true)
    expect(reading.shells.some((facts) => facts.shellId === 'b70')).toBe(true)
    expect(reading.shells.some((facts) => facts.shellId === 'b69')).toBe(false)
  })
})
