import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  RuntimeInspectResult,
  RuntimeListResult,
  RuntimeRef,
  RuntimeSessionInfo,
  TerminalProjectionSnapshot,
} from '../../../app-host/app/wire/hostWire.js'
import type { HostCallResult } from '../../hostClient/hostClient.types'
import type { SessionRecordAgent } from '../records/sessionRecord.types'
import type { AgentWorkFrame } from './agentWorkInspector.types'
import { WorkFixtures } from './fixtures/workFixtures'
import type { HostRuntimeReader } from './workStateMonitor'
import { WorkStateMonitor } from './workStateMonitor'

describe('lib-orchestrator/sessionManager/workState/workStateMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function frameOf(file: string): AgentWorkFrame {
    const fixture = WorkFixtures.all().find((candidate) => candidate.file === file)
    if (fixture === undefined) throw new Error(`missing work fixture ${file}`)
    return fixture.frame
  }

  const claudeWorkingScreenConst = frameOf('claude-working-spinner.json').screenTail
  const claudeIdleScreenConst = frameOf('claude-idle-prompt.json').screenTail
  const claudeBlockedRawConst = frameOf('claude-blocked-prompt.json').rawTail
  const planApprovalScreenConst = frameOf('claude-live-plan-approval.json').screenTail
  const planApprovalRawConst = frameOf('claude-live-plan-approval.json').rawTail
  const backgroundScreenConst = frameOf('claude-live-background-tasks.json').screenTail
  const backgroundRawConst = frameOf('claude-live-background-tasks.json').rawTail
  const codexWorkingScreenConst = frameOf('codex-working-seconds.json').screenTail
  const codexLiveWideWorkingScreenConst = frameOf('codex-live-working-wide-screen.json').wideScreenTail
  const codexQuietScreenConst = frameOf('codex-unknown-prompt.json').screenTail
  const codexIdleScreenConst = frameOf('codex-live-idle.json').screenTail
  const codexBackgroundFrameConst = frameOf('codex-live-background-terminal.json')

  interface FakeRuntime {
    runtimeSessionId: string
    agent: SessionRecordAgent['agentId'] | null
    alive: boolean
    outputSeq: number
    lastOutputAt: number | null
    raw: string
    screen: string
  }

  interface Harness {
    monitor: WorkStateMonitor
    calls: { inspect: string[] }
    changes: () => number
    add: (runtime: Partial<FakeRuntime> & Pick<FakeRuntime, 'runtimeSessionId' | 'agent'>) => void
    /** New output arrived: the sequence moves and the Host stamps the moment. */
    emit: (runtimeSessionId: string, screen?: string, raw?: string) => void
    remove: (runtimeSessionId: string) => void
    /** The Host still LISTS it, and reports it dead: what an exit looks like before the sweep. */
    kill: (runtimeSessionId: string) => void
    /** What the session manager's own poll would hand over. */
    listing: () => RuntimeListResult
    observe: () => Promise<void>
    answerInspect: (ok: boolean) => void
    /** Holds every inspect open until it is called, so a second listing meets a pass in flight. */
    blockInspect: () => () => void
  }

  function harness(): Harness {
    const runtimes: FakeRuntime[] = []
    const calls = { inspect: [] as string[] }
    let inspectOk = true
    let held: Promise<void> | null = null
    let changes = 0
    const find = (runtimeSessionId: string): FakeRuntime | undefined =>
      runtimes.find((runtime) => runtime.runtimeSessionId === runtimeSessionId)
    const info = (runtime: FakeRuntime): RuntimeSessionInfo => ({
      runtimeSessionId: runtime.runtimeSessionId,
      generation: 1,
      alive: runtime.alive,
      cols: 120,
      rows: 30,
      outputSeq: runtime.outputSeq,
      outputEpoch: 1,
      lastOutputAt: runtime.lastOutputAt,
      startedAt: 0,
    })
    /*
     * A fixture's `screenTail` is already a WINDOW, so its lines are the physical rows of the
     * terminal it was recorded on - several of them wider than the 120 columns this fake reports
     * for its listing. Handing that back as a screen at 120 columns would let `frameOf` wrap each
     * one into two or three rows and push the status line out of the window it is here to be read
     * in. So the fake terminal is as wide as the widest row it is asked to show: what this suite
     * measures is the monitor's clock, not the windowing that `screenTail.test.ts` owns.
     */
    const projection = (runtime: FakeRuntime): TerminalProjectionSnapshot => ({
      ...info(runtime),
      outputEpoch: 1,
      raw: runtime.raw,
      screen: runtime.screen,
      cols: Math.max(120, ...runtime.screen.split(/\r?\n/).map((row) => row.length)),
    })
    const client: HostRuntimeReader = {
      runtimeInspect: async (target: RuntimeRef): Promise<HostCallResult<RuntimeInspectResult>> => {
        calls.inspect.push(target.runtimeSessionId)
        if (held !== null) await held
        if (!inspectOk)
          return { ok: false, code: 'op-rejected', status: 409, detail: 'the fake Host refused' }
        const runtime = find(target.runtimeSessionId)
        if (runtime === undefined)
          return { ok: false, code: 'op-rejected', status: 404, detail: 'no such runtime' }
        return { ok: true, value: { session: info(runtime), projection: projection(runtime) } }
      },
    }
    const monitor = new WorkStateMonitor({
      client,
      agentOf: (runtimeSessionId) => find(runtimeSessionId)?.agent ?? null,
      onChanged: () => { changes += 1 },
    })
    const listing = (): RuntimeListResult => ({
      sessions: runtimes.map(info),
      throughRevision: 1,
      hostInstanceId: 'host-1',
    })
    return {
      monitor,
      calls,
      changes: () => changes,
      listing,
      observe: () => monitor.observe(listing()),
      add: (runtime) => {
        runtimes.push({
          alive: true,
          outputSeq: 1,
          lastOutputAt: Date.now(),
          raw: '',
          screen: '',
          ...runtime,
        })
      },
      kill: (runtimeSessionId) => {
        const runtime = find(runtimeSessionId)
        if (!runtime) throw new Error(`no fake runtime ${runtimeSessionId}`)
        runtime.alive = false
      },
      emit: (runtimeSessionId, screen, raw) => {
        const runtime = find(runtimeSessionId)
        if (runtime === undefined) throw new Error(`no fake runtime ${runtimeSessionId}`)
        runtime.outputSeq += 10
        runtime.lastOutputAt = Date.now()
        if (screen !== undefined) runtime.screen = screen
        if (raw !== undefined) runtime.raw = raw
      },
      remove: (runtimeSessionId) => {
        runtimes.splice(runtimes.findIndex((runtime) => runtime.runtimeSessionId === runtimeSessionId), 1)
      },
      answerInspect: (ok) => { inspectOk = ok },
      blockInspect: () => {
        let release = (): void => undefined
        held = new Promise<void>((resolve) => { release = resolve })
        return () => {
          held = null
          release()
        }
      },
    }
  }

  // There is one poll of one Host in this client and it belongs to the session manager. Nothing here
  // is on a clock: a monitor nobody hands a listing to asks the Host nothing, for ever.
  it('classifies nothing until it is handed a listing', async () => {
    const context = harness()
    context.add({ runtimeSessionId: 'a', agent: 'claude', screen: claudeWorkingScreenConst })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(context.calls.inspect).toHaveLength(0)
    expect(context.monitor.activity('a')).toBeNull()

    context.emit('a')
    await context.observe()
    expect(context.calls.inspect).toEqual(['a'])
    expect(context.monitor.activity('a')).toBe('working')
  })

  // The listing already carries outputSeq, so noticing that a screen cannot have changed is free. The
  // render behind runtime.inspect is what must be earned.
  it('inspects a session only when its output moved', async () => {
    const context = harness()
    context.add({ runtimeSessionId: 'a', agent: 'claude', screen: claudeWorkingScreenConst })
    await context.observe()
    expect(context.calls.inspect).toEqual(['a'])
    expect(context.monitor.activity('a')).toBe('working')

    await vi.advanceTimersByTimeAsync(2_000)
    await context.observe()
    expect(context.calls.inspect).toEqual(['a'])

    context.emit('a')
    await context.observe()
    expect(context.calls.inspect).toEqual(['a', 'a'])
  })

  // The screen still shows the spinner throughout: the verdict comes from the age of the output, not
  // from what the settling look happens to find, and it costs exactly one look.
  it('settles a working session to idle after fifteen seconds of silence', async () => {
    const context = harness()
    context.add({ runtimeSessionId: 'a', agent: 'claude', screen: claudeWorkingScreenConst })
    await context.observe()
    expect(context.monitor.activity('a')).toBe('working')

    await vi.advanceTimersByTimeAsync(12_000)
    await context.observe()
    expect(context.monitor.activity('a')).toBe('working')
    expect(context.calls.inspect).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(4_000)
    await context.observe()
    expect(context.monitor.activity('a')).toBe('idle')
    expect(context.calls.inspect).toHaveLength(2)

    await vi.advanceTimersByTimeAsync(30_000)
    await context.observe()
    expect(context.calls.inspect).toHaveLength(2)
  })

  it('keeps a cursor-restored Codex working status active through output silence', async () => {
    const context = harness()
    context.add({
      runtimeSessionId: 'c',
      agent: 'codex',
      screen: codexLiveWideWorkingScreenConst,
      lastOutputAt: Date.now() - 60_000,
    })
    await context.observe()
    expect(context.monitor.inspection('c')?.hint).toBe('working')
    expect(context.monitor.inspection('c')?.evidence.map((item) => item.source)).toEqual(['screen'])
    expect(context.monitor.activity('c')).toBe('working')

    const settles = 3
    for (let window = 0; window < settles; window += 1) {
      await vi.advanceTimersByTimeAsync(15_000)
      await context.observe()
    }
    expect(context.monitor.activity('c')).toBe('working')
    expect(context.calls.inspect.length).toBe(1 + settles)
    expect(context.changes()).toBe(1)

    context.emit('c', codexIdleScreenConst, codexIdleScreenConst)
    await context.observe()
    expect(context.monitor.activity('c')).toBe('working')

    await vi.advanceTimersByTimeAsync(15_000)
    await context.observe()
    expect(context.monitor.activity('c')).toBe('idle')
    expect(context.changes()).toBe(2)
  })

  // A raw tail keeps a busy marker long after the screen moved on. V1 answered that with a mode that
  // dropped the raw window; here the output timestamp answers it, on the very first look.
  it('refuses to call a session working on evidence older than the silence window', async () => {
    const context = harness()
    context.add({ runtimeSessionId: 'a', agent: 'claude', screen: claudeWorkingScreenConst })
    await context.observe()
    expect(context.monitor.activity('a')).toBe('working')

    context.emit('a')
    vi.setSystemTime(Date.now() + 20_000)
    await context.observe()
    expect(context.monitor.activity('a')).toBe('idle')
  })

  it('takes an idle screen for a pause while the output is still fresh', async () => {
    const context = harness()
    context.add({ runtimeSessionId: 'a', agent: 'claude', screen: claudeWorkingScreenConst })
    await context.observe()
    context.emit('a', claudeIdleScreenConst)
    await context.observe()
    expect(context.monitor.activity('a')).toBe('working')
  })

  // A permission prompt is evidence in itself: it produces no further output, so nothing would ever
  // refresh it, and a session cannot be allowed to settle out of it.
  // On screen, which is what the name always said and what the classifier now requires: a prompt
  // that survives only in the ring is one the screen has moved past.
  it('holds a waiting session for as long as the prompt is on screen', async () => {
    const context = harness()
    context.add({
      runtimeSessionId: 'a',
      agent: 'claude',
      screen: claudeBlockedRawConst,
      raw: claudeBlockedRawConst,
    })
    await context.observe()
    expect(context.monitor.activity('a')).toBe('waiting')

    await vi.advanceTimersByTimeAsync(60_000)
    await context.observe()
    expect(context.monitor.activity('a')).toBe('waiting')
    expect(context.calls.inspect).toHaveLength(1)
  })

  // The bug this subsystem was reworked for, pinned from the monitor's side. A misread prompt used
  // to reach here as a fresh `idle`, and `settle` turns that into `working` for fifteen seconds
  // before dropping it to idle - so the row read working, then idle, and never waiting. Now the
  // classifier answers `blocked` off the screen, and the point of this test is that settle passes a
  // waiting verdict through untouched, however fresh the output behind it is.
  it('lands waiting on the first look at a plan-approval screen, fresh output and all', async () => {
    const context = harness()
    context.add({ runtimeSessionId: 'a', agent: 'claude' })
    context.emit('a', planApprovalScreenConst, planApprovalRawConst)
    await context.observe()
    expect(context.monitor.activity('a')).toBe('waiting')
  })

  // A prompt is evidence in itself, so it is not on the silence clock at all: nothing about the
  // screen changed, and nothing about the answer may either.
  it('holds the plan prompt through silence past the settle window', async () => {
    const context = harness()
    context.add({ runtimeSessionId: 'a', agent: 'claude' })
    context.emit('a', planApprovalScreenConst, planApprovalRawConst)
    await context.observe()

    await vi.advanceTimersByTimeAsync(60_000)
    await context.observe()
    expect(context.monitor.activity('a')).toBe('waiting')
    expect(context.calls.inspect).toHaveLength(1)
  })

  // The evidence is kept, not just the answer: it is what the Debug window draws, and what makes a
  // wrong verdict visible without a probe. It lives exactly as long as the activity does.
  it('keeps the reason for its answer, and drops it with the runtime', async () => {
    const context = harness()
    context.add({ runtimeSessionId: 'a', agent: 'claude' })
    context.emit('a', planApprovalScreenConst, planApprovalRawConst)
    await context.observe()
    const inspection = context.monitor.inspection('a')
    expect(inspection?.hint).toBe('blocked')
    expect(inspection?.evidence.map((item) => item.signal)).toContain('planApproval')

    context.remove('a')
    await context.observe()
    expect(context.monitor.inspection('a')).toBeNull()
    expect(context.monitor.inspection('never-seen')).toBeNull()
  })

  // The user's case, from the monitor's side: a turn is over, two tasks are still running, and the
  // row must read working rather than finished. The footer is aged by the SIGHTING, so a background
  // build that prints nothing for a minute keeps the row green - the settle-due re-inspection
  // re-reads the same screen and re-arms the clock.
  it('holds a background session green through silence, on one inspect per settle', async () => {
    const context = harness()
    context.add({ runtimeSessionId: 'a', agent: 'claude' })
    context.emit('a', backgroundScreenConst, backgroundRawConst)
    await context.observe()
    expect(context.monitor.activity('a')).toBe('working')
    expect(context.monitor.activityDetail('a')).toBe('background')

    // One observation per settle window rather than one jump over four of them: the claim is about
    // CADENCE, and a single `observe` after 60 s can only ever prove that one re-inspection
    // happened. The old `toBeGreaterThan(1)` passed on exactly that, which is 2.
    const settles = 4
    for (let window = 0; window < settles; window += 1) {
      await vi.advanceTimersByTimeAsync(15_000)
      await context.observe()
    }

    expect(context.monitor.activity('a')).toBe('working')
    expect(context.monitor.activityDetail('a')).toBe('background')
    // The first look plus one per due settle, and nothing in between: the screen is re-read on the
    // window, not on every pass.
    expect(context.calls.inspect.length).toBe(1 + settles)
    // And the row never left `working`, so nothing raised a mark on the way.
    expect(context.changes()).toBe(1)
  })

  // And the other half: when the tasks end, the footer goes with them, and the row drops once. That
  // single transition is the one attention mark, at the true end of all the work.
  it('drops to idle once when the footer clears, not on every quiet stretch', async () => {
    const context = harness()
    context.add({ runtimeSessionId: 'a', agent: 'claude' })
    context.emit('a', backgroundScreenConst, backgroundRawConst)
    await context.observe()
    expect(context.monitor.activity('a')).toBe('working')
    expect(context.monitor.activityDetail('a')).toBe('background')

    // Quiet stretches first, with nothing printed: they must not drop the row on their own.
    for (let window = 0; window < 3; window += 1) {
      await vi.advanceTimersByTimeAsync(15_000)
      await context.observe()
    }
    expect(context.monitor.activity('a')).toBe('working')

    // Erasing the footer is itself output, so the next listing carries it.
    context.emit('a', claudeIdleScreenConst, claudeIdleScreenConst)
    await context.observe()
    await vi.advanceTimersByTimeAsync(60_000)
    await context.observe()

    expect(context.monitor.activity('a')).toBe('idle')
    expect(context.monitor.activityDetail('a')).toBeNull()
    // "once" is the whole claim of the name, so it is counted: working, then idle, and nothing
    // flapping between them across the quiet stretches above.
    expect(context.changes()).toBe(2)
  })

  // The same clock through the other inspector: Codex has finished its foreground turn, but the
  // yielded terminal named on its current screen is still work. The shared background hint holds it
  // green until that status disappears, without a Codex-specific monitor branch.
  it('holds a Codex background-terminal wait green, then drops once it clears', async () => {
    const context = harness()
    context.add({ runtimeSessionId: 'c', agent: 'codex' })
    context.emit(
      'c',
      codexBackgroundFrameConst.screenTail,
      codexBackgroundFrameConst.rawTail,
    )
    await context.observe()
    expect(context.monitor.activity('c')).toBe('working')
    expect(context.monitor.activityDetail('c')).toBe('background')
    expect(context.monitor.inspection('c')?.hint).toBe('background')

    const settles = 3
    for (let window = 0; window < settles; window += 1) {
      await vi.advanceTimersByTimeAsync(15_000)
      await context.observe()
    }
    expect(context.monitor.activity('c')).toBe('working')
    expect(context.monitor.activityDetail('c')).toBe('background')
    expect(context.calls.inspect.length).toBe(1 + settles)
    expect(context.changes()).toBe(1)

    context.emit('c', codexIdleScreenConst, codexIdleScreenConst)
    await context.observe()
    await vi.advanceTimersByTimeAsync(15_000)
    await context.observe()
    expect(context.monitor.activity('c')).toBe('idle')
    expect(context.monitor.activityDetail('c')).toBeNull()
    expect(context.changes()).toBe(2)
  })

  it('publishes a foreground-to-background detail change without pretending the turn settled', async () => {
    const context = harness()
    context.add({ runtimeSessionId: 'a', agent: 'claude', screen: claudeWorkingScreenConst })
    await context.observe()
    expect(context.monitor.activity('a')).toBe('working')
    expect(context.monitor.activityDetail('a')).toBeNull()

    context.emit('a', backgroundScreenConst, backgroundRawConst)
    await context.observe()

    expect(context.monitor.activity('a')).toBe('working')
    expect(context.monitor.activityDetail('a')).toBe('background')
    expect(context.changes()).toBe(2)
  })

  it('never classifies a shell', async () => {
    const context = harness()
    context.add({ runtimeSessionId: 'shell-1', agent: null, screen: claudeWorkingScreenConst })
    context.add({ runtimeSessionId: 'a', agent: 'claude', screen: claudeWorkingScreenConst })
    await context.observe()
    expect(context.calls.inspect).toEqual(['a'])
    expect(context.monitor.activity('shell-1')).toBeNull()
    expect(context.monitor.activityDetail('shell-1')).toBeNull()
  })

  // An unrecognized Codex screen is still unknown until it has been seen working at least once.
  // After that, silence is what makes it idle.
  it('keeps Codex unknown until it has worked, then settles it', async () => {
    const context = harness()
    context.add({ runtimeSessionId: 'c', agent: 'codex', screen: codexQuietScreenConst })
    await context.observe()
    expect(context.monitor.activity('c')).toBe('unknown')
    expect(context.changes()).toBe(0)

    context.emit('c', codexWorkingScreenConst)
    await context.observe()
    expect(context.monitor.activity('c')).toBe('working')
    expect(context.changes()).toBe(1)

    context.emit('c', codexQuietScreenConst)
    await vi.advanceTimersByTimeAsync(20_000)
    await context.observe()
    expect(context.monitor.activity('c')).toBe('idle')
  })

  it('reports a change once per change, not once per listing', async () => {
    const context = harness()
    context.add({ runtimeSessionId: 'a', agent: 'claude', screen: claudeWorkingScreenConst })
    await context.observe()
    expect(context.changes()).toBe(1)
    context.emit('a')
    await context.observe()
    expect(context.changes()).toBe(1)
  })

  it('forgets a runtime that is gone', async () => {
    const context = harness()
    context.add({ runtimeSessionId: 'a', agent: 'claude', screen: claudeWorkingScreenConst })
    await context.observe()
    expect(context.monitor.activity('a')).toBe('working')
    context.remove('a')
    await context.observe()
    expect(context.monitor.activity('a')).toBeNull()
    expect(context.changes()).toBe(2)
  })

  /**
   * The other half of `gone or dead`, which the test above promised in its name and never had: a
   * runtime the Host still LISTS, with `alive: false`. `classifyListing` skips it beside the shells,
   * so it is forgotten the same way and is never inspected - a dead screen has nothing to say about
   * what a session is doing, and asking would spend a call on it every pass.
   */
  it('forgets a runtime the Host still lists but reports dead, without inspecting it', async () => {
    const context = harness()
    context.add({ runtimeSessionId: 'a', agent: 'claude', screen: claudeWorkingScreenConst })
    await context.observe()
    expect(context.monitor.activity('a')).toBe('working')

    context.kill('a')
    const before = context.calls.inspect.length
    await context.observe()

    expect(context.monitor.activity('a')).toBeNull()
    expect(context.calls.inspect.length).toBe(before)
  })

  // An absence of evidence is not evidence of a change: the classifier answers `unknown`, and the
  // settle rule - which runs on the age of the output, not on this call - keeps the last verdict.
  it('holds what it knows when the Host refuses to render the screen', async () => {
    const context = harness()
    context.add({ runtimeSessionId: 'a', agent: 'claude', screen: claudeWorkingScreenConst })
    await context.observe()
    expect(context.monitor.activity('a')).toBe('working')

    context.answerInspect(false)
    context.emit('a')
    await context.observe()
    expect(context.monitor.activity('a')).toBe('working')
    expect(context.calls.inspect).toHaveLength(2)
  })

  // The manager polls on its own clock and does not wait for this: a listing that lands mid-pass is
  // dropped rather than queued, because the next one is two seconds away and carries fresher output.
  it('drops a listing that arrives while it is still rendering screens', async () => {
    const context = harness()
    context.add({ runtimeSessionId: 'a', agent: 'claude', screen: claudeWorkingScreenConst })
    const release = context.blockInspect()
    const inFlight = context.observe()
    await Promise.resolve()
    expect(context.calls.inspect).toHaveLength(1)

    await context.observe()
    expect(context.calls.inspect).toHaveLength(1)
    release()
    await inFlight
    expect(context.monitor.activity('a')).toBe('working')
  })

  it('drops what it learned when it is stopped', async () => {
    const context = harness()
    context.add({ runtimeSessionId: 'a', agent: 'claude', screen: claudeWorkingScreenConst })
    await context.observe()
    expect(context.monitor.activity('a')).toBe('working')
    context.monitor.stop()
    expect(context.monitor.activity('a')).toBeNull()
  })

  /*
   * A pass is a chain of awaited inspects, so `stop` lands in the middle of one: the client is
   * closing under it and the manager has already let go. What it learns after that must not refill
   * the map that was just cleared, and must not report a change to anybody.
   */
  it('learns nothing more once it has been stopped mid-pass', async () => {
    const context = harness()
    context.add({ runtimeSessionId: 'a', agent: 'claude', screen: claudeWorkingScreenConst })
    const release = context.blockInspect()
    const inFlight = context.observe()
    await Promise.resolve()
    expect(context.calls.inspect).toHaveLength(1)

    context.monitor.stop()
    release()
    await inFlight
    expect(context.monitor.activity('a')).toBeNull()
    expect(context.changes()).toBe(0)

    // And it stays stopped: a listing handed to it afterwards asks the Host nothing.
    await context.observe()
    expect(context.calls.inspect).toHaveLength(1)
  })
})
