import { readFileSync } from 'fs'
import { getRendererAgent } from '../core/agents/renderer.js'
import type { AgentId } from '../core/types/contracts.js'
import type {
  AgentWorkDetectorScheduler,
  AgentWorkFrame,
  AgentWorkReport,
  AgentWorkStatus,
  AgentWorkTimer,
} from '../core/agents/workDetection/agentWorkDetector.types.js'

type WorkFixture = Omit<AgentWorkFrame, 'timestamp'> & { name: string }

interface FakeClock {
  scheduler: AgentWorkDetectorScheduler
  advance(ms: number): void
}

interface DetectorHarness {
  detector: ReturnType<ReturnType<typeof getRendererAgent>['createWorkDetector']>
  statuses: AgentWorkStatus[]
  reports: AgentWorkReport[]
  background: boolean[]
  idleCalls(): number
  readFrame(): AgentWorkFrame
  setFixture(fixture: WorkFixture): void
  clock: FakeClock
}

let passed = 0
let failed = 0

function ok(label: string, condition: boolean, detail?: string): void {
  if (condition) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
}

function loadFixtures(relativeUrl: string): WorkFixture[] {
  return JSON.parse(readFileSync(new URL(relativeUrl, import.meta.url), 'utf8')) as WorkFixture[]
}

function fixture(fixtures: WorkFixture[], name: string): WorkFixture {
  const value = fixtures.find((item) => item.name === name)
  if (!value) throw new Error(`Missing work-detection fixture: ${name}`)
  return value
}

function createFakeClock(): FakeClock {
  let now = 0
  let nextId = 1
  const tasks = new Map<number, { at: number; handler: () => void }>()
  const scheduler: AgentWorkDetectorScheduler = {
    now: () => now,
    setTimeout: (handler, delayMs) => {
      const id = nextId++
      tasks.set(id, { at: now + delayMs, handler })
      return id as unknown as AgentWorkTimer
    },
    clearTimeout: (timer) => { tasks.delete(timer as unknown as number) },
  }
  return {
    scheduler,
    advance: (ms) => {
      const target = now + ms
      while (true) {
        let next: { id: number; at: number; handler: () => void } | null = null
        for (const [id, task] of tasks)
          if (task.at <= target && (!next || task.at < next.at || (task.at === next.at && id < next.id)))
            next = { id, ...task }
        if (!next) break
        tasks.delete(next.id)
        now = next.at
        next.handler()
      }
      now = target
    },
  }
}

function createHarness(agent: AgentId, initial: WorkFixture): DetectorHarness {
  const clock = createFakeClock()
  let current = initial
  let idleCount = 0
  const statuses: AgentWorkStatus[] = []
  const reports: AgentWorkReport[] = []
  const background: boolean[] = []
  const readFrame = (): AgentWorkFrame => ({ ...current, timestamp: clock.scheduler.now() })
  const detector = getRendererAgent(agent).createWorkDetector({
    readFrame,
    onStatus: (status) => statuses.push(status),
    onBackgroundActivity: (active) => background.push(active),
    onIdle: () => { idleCount++ },
    onReport: (report) => reports.push(report),
  }, clock.scheduler)
  return {
    detector,
    statuses,
    reports,
    background,
    idleCalls: () => idleCount,
    readFrame,
    setFixture: (value) => { current = value },
    clock,
  }
}

function lastReport(harness: DetectorHarness): AgentWorkReport {
  const report = harness.reports.at(-1)
  if (!report) throw new Error('Detector did not publish a report')
  return report
}

const claudeFixtures = loadFixtures('../core/agents/claude/fixtures/work-detection.json')
const codexFixtures = loadFixtures('../core/agents/codex/fixtures/work-detection.json')

console.log('\n[1] Claude working evidence and fast idle')
{
  const harness = createHarness('claude', fixture(claudeFixtures, 'wide elapsed working'))
  harness.detector.onOutput(harness.readFrame())
  ok('wide elapsed row marks Claude running', harness.detector.currentStatus === 'running')
  ok('wide-screen evidence identifies elapsedDot', lastReport(harness).evidence.some((item) => item.source === 'wide-screen' && item.signal === 'elapsedDot'))
  harness.clock.advance(15000)
  ok('settled working row survives the silence fallback', harness.detector.currentStatus === 'running')
  harness.setFixture(fixture(claudeFixtures, 'idle prompt'))
  harness.detector.onRenderedFrame(harness.readFrame())
  harness.clock.advance(600)
  harness.setFixture(fixture(claudeFixtures, 'spinner working'))
  harness.detector.onRenderedFrame(harness.readFrame())
  harness.clock.advance(600)
  ok('later active evidence cancels a pending fast idle', harness.detector.currentStatus === 'running')
  harness.setFixture(fixture(claudeFixtures, 'idle prompt'))
  harness.detector.onRenderedFrame(harness.readFrame())
  harness.clock.advance(1199)
  ok('fast-idle timer does not fire early', harness.detector.currentStatus === 'running')
  harness.clock.advance(1)
  ok('settled idle screen flips Claude idle after 1.2s', harness.detector.currentStatus === 'idle')
  harness.detector.dispose()
}

console.log('\n[2] Claude stale raw output and provider-specific states')
{
  const stale = createHarness('claude', fixture(claudeFixtures, 'stale raw busy with idle screen'))
  stale.detector.onOutput(stale.readFrame())
  ok('raw busy evidence starts the turn immediately', stale.detector.currentStatus === 'running')
  stale.clock.advance(15000)
  ok('settled idle ignores stale raw busy history', stale.detector.currentStatus === 'idle')

  const spinner = createHarness('claude', fixture(claudeFixtures, 'spinner working'))
  spinner.detector.onRenderedFrame(spinner.readFrame())
  ok('spinner-only screen is working', spinner.detector.currentStatus === 'running')
  ok('spinner evidence is named', lastReport(spinner).evidence.some((item) => item.signal === 'spinnerGlyph'))

  const tool = createHarness('claude', fixture(claudeFixtures, 'tool use'))
  tool.detector.onOutput(tool.readFrame())
  ok('tool marker enters tool-use', tool.detector.currentStatus === 'tool-use')
  tool.clock.advance(3000)
  ok('tool-use expires back to running', tool.detector.currentStatus === 'running')

  const blocked = createHarness('claude', fixture(claudeFixtures, 'blocked prompt'))
  blocked.detector.onOutput(blocked.readFrame())
  ok('permission prompt enters blocked', blocked.detector.currentStatus === 'blocked')

  const waiting = createHarness('claude', fixture(claudeFixtures, 'question menu'))
  waiting.detector.onOutput(waiting.readFrame())
  ok('question menu enters waiting', waiting.detector.currentStatus === 'waiting')

  const shell = createHarness('claude', fixture(claudeFixtures, 'background shell'))
  shell.detector.onRenderedFrame(shell.readFrame())
  ok('background shell stays orthogonal to idle status', shell.detector.currentStatus === 'idle')
  ok('background shell publishes activity', shell.background.at(-1) === true)

  const agent = createHarness('claude', fixture(claudeFixtures, 'background agent'))
  agent.detector.onRenderedFrame(agent.readFrame())
  ok('background sub-agent stays orthogonal to idle status', agent.detector.currentStatus === 'idle')
  ok('background sub-agent publishes activity', agent.background.at(-1) === true)

  const prose = createHarness('claude', fixture(claudeFixtures, 'markdown and elapsed prose'))
  prose.detector.onRenderedFrame(prose.readFrame())
  ok('markdown bullets and prose elapsed times stay idle', prose.detector.currentStatus === 'idle')

  for (const harness of [stale, spinner, tool, blocked, waiting, shell, agent, prose]) harness.detector.dispose()
}

console.log('\n[3] Codex screenshot-backed Working row')
{
  const harness = createHarness('codex', fixture(codexFixtures, 'working screenshot'))
  harness.detector.onOutput(harness.readFrame())
  ok('screenshot row marks Codex running', harness.detector.currentStatus === 'running')
  ok('report identifies Codex workingRow evidence', lastReport(harness).agent === 'codex' && lastReport(harness).evidence.some((item) => item.signal === 'workingRow'))
  harness.clock.advance(15000)
  ok('rendered Working row survives the silence fallback', harness.detector.currentStatus === 'running')

  harness.setFixture(fixture(codexFixtures, 'idle prompt'))
  harness.detector.onOutput(harness.readFrame())
  harness.detector.onRenderedFrame(harness.readFrame())
  ok('rendered frame without Working stays unknown instead of declaring idle', harness.detector.currentStatus === 'running' && lastReport(harness).verdict === 'unknown')
  harness.clock.advance(14999)
  ok('Codex remains running before conservative timeout', harness.detector.currentStatus === 'running')
  harness.clock.advance(1)
  ok('Codex settles idle after 15s without Working evidence', harness.detector.currentStatus === 'idle')
  harness.detector.dispose()
}

console.log('\n[4] Codex false positives, menu reset, exit, and disposal')
{
  const prose = createHarness('codex', fixture(codexFixtures, 'ordinary working prose'))
  prose.detector.onRenderedFrame(prose.readFrame())
  ok('ordinary prose on a settled screen does not activate Codex', prose.detector.currentStatus === 'idle' && lastReport(prose).verdict === 'unknown')

  const output = createHarness('codex', fixture(codexFixtures, 'ordinary working prose'))
  output.detector.onOutput(output.readFrame())
  ok('non-Working PTY output still starts Codex activity', output.detector.currentStatus === 'running' && lastReport(output).evidence.some((item) => item.signal === 'outputActivity'))
  output.clock.advance(15000)
  ok('non-Working output activity settles idle after silence', output.detector.currentStatus === 'idle')

  const seconds = createHarness('codex', fixture(codexFixtures, 'working seconds'))
  seconds.detector.onOutput(seconds.readFrame())
  ok('short seconds Working row is detected', seconds.detector.currentStatus === 'running')
  const wrapped = createHarness('codex', fixture(codexFixtures, 'working wrapped'))
  wrapped.detector.onRenderedFrame(wrapped.readFrame())
  ok('wrapped rendered Working row is detected', wrapped.detector.currentStatus === 'running')
  seconds.setFixture(fixture(codexFixtures, 'menu phase'))
  seconds.detector.onOutput(seconds.readFrame())
  ok('menu phase resets an active detector', seconds.detector.currentStatus === 'idle' && seconds.idleCalls() === 1)
  seconds.clock.advance(15000)
  ok('menu reset cancels the prior silence timer', seconds.detector.currentStatus === 'idle' && seconds.idleCalls() === 1)

  const exited = createHarness('codex', fixture(codexFixtures, 'idle prompt'))
  exited.detector.onProcessExit()
  ok('process exit enters done', exited.detector.currentStatus === 'done')
  exited.clock.advance(3000)
  ok('done returns to idle exactly once after 3s', exited.detector.currentStatus === 'idle' && exited.statuses.join(',') === 'done,idle' && exited.idleCalls() === 1)

  const disposed = createHarness('codex', fixture(codexFixtures, 'working screenshot'))
  disposed.detector.onOutput(disposed.readFrame())
  disposed.setFixture(fixture(codexFixtures, 'idle prompt'))
  disposed.detector.onOutput(disposed.readFrame())
  disposed.detector.dispose()
  disposed.clock.advance(15000)
  ok('dispose cancels pending state changes', disposed.detector.currentStatus === 'running')

  for (const harness of [prose, output, seconds, wrapped, exited]) harness.detector.dispose()
}

console.log('\n[5] Detector instances stay isolated')
{
  const claude = createHarness('claude', fixture(claudeFixtures, 'wide elapsed working'))
  const codex = createHarness('codex', fixture(codexFixtures, 'working screenshot'))
  claude.detector.onOutput(claude.readFrame())
  codex.detector.onOutput(codex.readFrame())
  claude.setFixture(fixture(claudeFixtures, 'idle prompt'))
  claude.detector.onRenderedFrame(claude.readFrame())
  claude.clock.advance(1200)
  ok('Claude can settle without changing Codex', claude.detector.currentStatus === 'idle' && codex.detector.currentStatus === 'running')
  codex.clock.advance(15000)
  ok('Codex keeps its own rendered Working state', codex.detector.currentStatus === 'running')
  claude.detector.dispose()
  codex.detector.dispose()
}

console.log(`\n=== ${failed === 0 ? 'PASS' : 'FAIL'} (${passed} passed, ${failed} failed)`)
process.exit(failed === 0 ? 0 : 1)
