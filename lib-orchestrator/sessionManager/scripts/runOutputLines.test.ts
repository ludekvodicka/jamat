import { describe, expect, it } from 'vitest'

import type {
  RuntimeInspectResult,
  RuntimeListResult,
  RuntimeRef,
  RuntimeSessionInfo,
  TerminalProjectionView,
} from '../../../app-host/app/wire/hostWire.js'
import type { HostCallResult } from '../../hostClient/hostClient.types'
import { RunOutputLines } from './runOutputLines'

describe('lib-orchestrator/sessionManager/scripts/runOutputLines', () => {
  describe('lastLineOf', () => {
    it('takes the last non-empty physical row', () => {
      expect(RunOutputLines.lastLineOf({ screenLines: ['A    src/a.ts', 'A    src/b.ts', '', ''], raw: 'other' }))
        .toBe('A    src/b.ts')
    })

    it('removes ANSI, the SGR 2/22 of styled rows and control characters', () => {
      expect(RunOutputLines.lastLineOf({ screenLines: ['\x1b[32mReply\x1b[0m from \x1b[2m127.0.0.1\x1b[22m\x07'] }))
        .toBe('Reply from 127.0.0.1')
      expect(RunOutputLines.lastLineOf({ screenLines: ['\x1b]0;title\x07done'] })).toBe('done')
    })

    it('keeps what follows the last carriage return of a raw row', () => {
      expect(RunOutputLines.lastLineOf({ raw: 'Progress\n40%\r60%\r80%' })).toBe('80%')
    })

    it('gives the line before a raw tail ending in a line break', () => {
      expect(RunOutputLines.lastLineOf({ raw: 'first\r\nsecond\r\n' })).toBe('second')
    })

    it('reads the raw tail when the physical rows are all empty', () => {
      expect(RunOutputLines.lastLineOf({ screenLines: ['', '  '], raw: 'from raw\n' })).toBe('from raw')
    })

    it('cuts a long line to 160 characters', () => {
      const line = RunOutputLines.lastLineOf({ screenLines: ['x'.repeat(300)] })
      expect(line).toBe('x'.repeat(RunOutputLines.lineCharactersMaxConst))
      expect(RunOutputLines.lineCharactersMaxConst).toBe(160)
    })

    it('gives null for an empty screen', () => {
      expect(RunOutputLines.lastLineOf({ screenLines: [], raw: '' })).toBeNull()
      expect(RunOutputLines.lastLineOf({})).toBeNull()
    })
  })

  interface FakeRuntime {
    runtimeSessionId: string
    alive: boolean
    outputSeq: number
    lines: string[]
    live: boolean
  }

  function harness() {
    const runtimes: FakeRuntime[] = []
    const inspected: string[] = []
    const views: (TerminalProjectionView | undefined)[] = []
    let refuse = false
    let withoutProjection = false
    let held: Promise<void> | null = null
    let changes = 0
    const find = (id: string): FakeRuntime | undefined => runtimes.find((runtime) => runtime.runtimeSessionId === id)
    const info = (runtime: FakeRuntime): RuntimeSessionInfo => ({
      runtimeSessionId: runtime.runtimeSessionId,
      generation: 1,
      alive: runtime.alive,
      cols: 120,
      rows: 30,
      outputSeq: runtime.outputSeq,
      outputEpoch: 1,
      lastOutputAt: 1,
      startedAt: 0,
    })
    const lines = new RunOutputLines({
      client: {
        runtimeInspect: async (target: RuntimeRef, view?: TerminalProjectionView): Promise<HostCallResult<RuntimeInspectResult>> => {
          inspected.push(target.runtimeSessionId)
          views.push(view)
          if (held !== null) await held
          const runtime = find(target.runtimeSessionId)
          if (refuse || runtime === undefined) return { ok: false, code: 'op-rejected', status: 409, detail: 'refused' }
          return {
            ok: true,
            value: {
              session: info(runtime),
              projection: withoutProjection ? null : { ...info(runtime), screen: '', raw: '', screenLines: runtime.lines },
            },
          }
        },
      },
      liveLineOf: (id) => find(id)?.live ?? false,
      onChanged: () => { changes += 1 },
    })
    const listing = (): RuntimeListResult => ({ sessions: runtimes.map(info), throughRevision: 1, hostInstanceId: 'host-1' })
    return {
      lines,
      inspected,
      views,
      changes: () => changes,
      observe: () => lines.observe(listing()),
      add: (runtime: Partial<FakeRuntime> & Pick<FakeRuntime, 'runtimeSessionId'>) => {
        runtimes.push({ alive: true, outputSeq: 1, lines: [], live: true, ...runtime })
      },
      print: (id: string, ...rows: string[]) => {
        const runtime = find(id)
        if (runtime === undefined) throw new Error(`no fake runtime ${id}`)
        runtime.outputSeq += 1
        runtime.lines = rows
      },
      end: (id: string) => {
        const runtime = find(id)
        if (runtime === undefined) throw new Error(`no fake runtime ${id}`)
        runtime.alive = false
      },
      refuse: (value: boolean) => { refuse = value },
      withoutProjection: (value: boolean) => { withoutProjection = value },
      hold: () => {
        let release = (): void => undefined
        held = new Promise<void>((resolve) => { release = resolve })
        return () => { held = null; release() }
      },
    }
  }

  it('inspects only alive runs whose definition says live line, with the bounded view', async () => {
    const h = harness()
    h.add({ runtimeSessionId: 'ping', lines: ['Reply from 127.0.0.1'] })
    h.add({ runtimeSessionId: 'resolver', live: false, lines: ['thinking'] })
    h.add({ runtimeSessionId: 'agent', live: false, lines: ['> prompt'] })
    h.add({ runtimeSessionId: 'gone', alive: false, lines: ['last'] })
    await h.observe()
    expect(h.inspected).toEqual(['ping'])
    expect(h.views).toEqual([RunOutputLines.viewConst])
    expect(RunOutputLines.viewConst).toEqual({ rawTailChars: 1_000, screenScrollbackRows: 0 })
    expect(h.lines.lineOf('ping')).toBe('Reply from 127.0.0.1')
    expect(h.lines.lineOf('resolver')).toBeNull()
    expect(h.changes()).toBe(1)
  })

  it('makes no inspect and no change while the output sequence stands', async () => {
    const h = harness()
    h.add({ runtimeSessionId: 'ping', lines: ['one'] })
    await h.observe()
    await h.observe()
    expect(h.inspected).toEqual(['ping'])
    expect(h.changes()).toBe(1)
    h.print('ping', 'two')
    await h.observe()
    expect(h.inspected).toEqual(['ping', 'ping'])
    expect(h.lines.lineOf('ping')).toBe('two')
    expect(h.changes()).toBe(2)
  })

  it('reports no change when new output leaves the same line', async () => {
    const h = harness()
    h.add({ runtimeSessionId: 'ping', lines: ['same'] })
    await h.observe()
    h.print('ping', 'same', '')
    await h.observe()
    expect(h.inspected).toHaveLength(2)
    expect(h.changes()).toBe(1)
  })

  it('keeps the last line when an inspect fails, and asks again on the next pass', async () => {
    const h = harness()
    h.add({ runtimeSessionId: 'ping', lines: ['one'] })
    await h.observe()
    h.print('ping', 'two')
    h.refuse(true)
    await h.observe()
    expect(h.lines.lineOf('ping')).toBe('one')
    expect(h.changes()).toBe(1)
    h.refuse(false)
    await h.observe()
    expect(h.inspected).toHaveLength(3)
    expect(h.lines.lineOf('ping')).toBe('two')
  })

  it('keeps the line and takes the sequence when the Host answers without a projection', async () => {
    const h = harness()
    h.add({ runtimeSessionId: 'ping', lines: ['one'] })
    await h.observe()
    h.print('ping', 'two')
    h.withoutProjection(true)
    await h.observe()
    expect(h.inspected).toEqual(['ping', 'ping'])
    expect(h.lines.lineOf('ping')).toBe('one')
    expect(h.changes()).toBe(1)
    await h.observe()
    await h.observe()
    expect(h.inspected).toEqual(['ping', 'ping'])
    h.withoutProjection(false)
    h.print('ping', 'three')
    await h.observe()
    expect(h.lines.lineOf('ping')).toBe('three')
  })

  it('takes the sequence of a run first answered without a projection, with no line and no change', async () => {
    const h = harness()
    h.add({ runtimeSessionId: 'ping', lines: ['one'] })
    h.withoutProjection(true)
    await h.observe()
    await h.observe()
    expect(h.inspected).toEqual(['ping'])
    expect(h.lines.lineOf('ping')).toBeNull()
    expect(h.changes()).toBe(0)
  })

  it('forgets an ended run before the slow inspect of another run in the same pass', async () => {
    const h = harness()
    h.add({ runtimeSessionId: 'ended', lines: ['ended line'] })
    h.add({ runtimeSessionId: 'slow', lines: ['slow 1'] })
    await h.observe()
    expect(h.lines.stepOf('ended')).not.toBeNull()
    h.end('ended')
    h.print('slow', 'slow 2')
    const release = h.hold()
    const pass = h.observe()
    expect(h.lines.stepOf('ended')).toBeNull()
    expect(h.changes()).toBe(2)
    expect(h.inspected).toEqual(['ended', 'slow', 'slow'])
    release()
    await pass
    expect(h.lines.lineOf('slow')).toBe('slow 2')
    expect(h.changes()).toBe(3)
  })

  it('forgets an ended run in a pass dropped as overlapping, and writes no line for a run that ended during its inspect', async () => {
    const h = harness()
    h.add({ runtimeSessionId: 'ended', lines: ['ended line'] })
    h.add({ runtimeSessionId: 'slow', lines: ['slow 1'] })
    await h.observe()
    h.print('slow', 'slow 2')
    const release = h.hold()
    const pass = h.observe()
    h.end('ended')
    h.end('slow')
    await h.observe()
    expect(h.lines.stepOf('ended')).toBeNull()
    expect(h.lines.stepOf('slow')).toBeNull()
    expect(h.changes()).toBe(2)
    release()
    await pass
    expect(h.inspected).toEqual(['ended', 'slow', 'slow'])
    expect(h.lines.lineOf('slow')).toBeNull()
    expect(h.changes()).toBe(2)
  })

  it('forgets the line of a run that ended, with one change', async () => {
    const h = harness()
    h.add({ runtimeSessionId: 'ping', lines: ['one'] })
    await h.observe()
    h.end('ping')
    await h.observe()
    expect(h.lines.lineOf('ping')).toBeNull()
    expect(h.lines.stepOf('ping')).toBeNull()
    expect(h.changes()).toBe(2)
  })

  it('sends one change for a pass that moved several lines', async () => {
    const h = harness()
    h.add({ runtimeSessionId: 'a', lines: ['a1'] })
    h.add({ runtimeSessionId: 'b', lines: ['b1'] })
    await h.observe()
    expect(h.changes()).toBe(1)
  })

  it('drops a pass that overlaps the previous one', async () => {
    const h = harness()
    h.add({ runtimeSessionId: 'ping', lines: ['one'] })
    const release = h.hold()
    const first = h.observe()
    await h.observe()
    release()
    await first
    expect(h.inspected).toEqual(['ping'])
    expect(h.changes()).toBe(1)
  })

  it('writes nothing and tells nobody once stopped during a pass', async () => {
    const h = harness()
    h.add({ runtimeSessionId: 'ping', lines: ['one'] })
    const release = h.hold()
    const pass = h.observe()
    h.lines.stop()
    release()
    await pass
    expect(h.lines.lineOf('ping')).toBeNull()
    expect(h.changes()).toBe(0)
    await h.observe()
    expect(h.inspected).toEqual(['ping'])
  })

  it('answers the line as a step with no detail, count or start', async () => {
    const h = harness()
    h.add({ runtimeSessionId: 'ping', lines: ['Reply from 127.0.0.1'] })
    await h.observe()
    expect(h.lines.stepOf('ping')).toEqual({ text: 'Reply from 127.0.0.1', detail: null, progress: null, startedAt: null })
  })
})
