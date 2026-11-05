/**
 * Profiles the main process of a running AppClientUI (or any Node process) for a while and prints
 * where its time goes: busy share, top self and inclusive time, and the call counts of named
 * functions. The `.cpuprofile` goes to disk for a closer look in DevTools.
 *
 *   pnpm tsx scripts/dev/profile-client.ts --pid <PID> [--seconds 30] [--port 9229]
 *       [--calls recompose,compose,commit] [--out <file.cpuprofile>]
 *
 * It exists so the measurement of docs/architecture/ui-responsiveness.md can be repeated with one
 * command instead of five scratch scripts.
 *
 * The PID is required and never looked up: the instance registry also lists the instance a person is
 * working in, and attaching an inspector to that one is a decision, not a default. The inspector is
 * opened with `process._debugProcess` and closed again from inside the target before the script
 * exits, also after a failure, so the port does not stay open. Before profiling, the target's own
 * `process.pid` is read back over the inspector; a different process on the port is refused.
 *
 * Precise coverage with call counts runs during the same window as the sampling profile, so the
 * counted functions run a little slower than they otherwise would; the busy share is the measurement,
 * the counts say how often.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

interface CallFrame {
  functionName: string
  url: string
  lineNumber: number
}

interface ProfileNode {
  id: number
  callFrame: CallFrame
  children?: number[]
}

interface CpuProfile {
  nodes: ProfileNode[]
  samples: number[]
  startTime: number
  endTime: number
}

interface CoverageFunction {
  functionName: string
  ranges: { startOffset: number; count: number }[]
}

interface CoverageScript {
  url: string
  functions: CoverageFunction[]
}

interface Options {
  pid: number
  seconds: number
  port: number
  calls: string[]
  out: string
}

class InspectorConnection {
  private readonly socket: WebSocket
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private nextId = 0

  constructor(socket: WebSocket) {
    this.socket = socket
    this.socket.onmessage = event => this.receive(String(event.data))
  }

  static async open(url: string): Promise<InspectorConnection> {
    const socket = new WebSocket(url)
    await new Promise<void>((done, fail) => {
      socket.onopen = () => done()
      socket.onerror = () => fail(new Error(`cannot open the inspector socket ${url}`))
    })
    return new InspectorConnection(socket)
  }

  send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.nextId
    return new Promise<T>((done, fail) => {
      this.pending.set(id, { resolve: value => done(value as T), reject: fail })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  close(): void {
    this.socket.close()
  }

  private receive(text: string): void {
    const message = JSON.parse(text) as { id?: number; result?: unknown; error?: unknown }
    if (message.id === undefined) return
    const waiter = this.pending.get(message.id)
    if (!waiter) return
    this.pending.delete(message.id)
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)))
    else waiter.resolve(message.result)
  }
}

class ProfileClient {
  private static readonly defaultSecondsConst = 30
  private static readonly defaultPortConst = 9229
  private static readonly samplingIntervalMicrosecondsConst = 1000
  private static readonly readyAttemptsConst = 50
  private static readonly readyDelayMillisecondsConst = 100
  private static readonly topRowsConst = 30
  private static readonly defaultCallsConst = [
    'recompose', 'compose', 'sessionInfoOf', 'runsOf', 'activityOf', 'changed', 'commit', 'writeAsync', 'assertValid',
  ]
  /** Frames that only carry other work; the top-level grouping skips them. */
  private static readonly glueConst = new Set(['(root)', '(program)', 'processTicksAndRejections', 'runMicrotasks', 'listOnTimeout', 'processTimers', 'emit', '(anon)'])

  static async main(argv: readonly string[]): Promise<void> {
    const options = ProfileClient.parse(argv)
    // Undocumented but stable since Node 0.x; @types/node does not declare it.
    ;(process as NodeJS.Process & { _debugProcess(pid: number): void })._debugProcess(options.pid)
    const url = await ProfileClient.debuggerUrl(options.port)
    const inspector = await InspectorConnection.open(url)
    try {
      const reported = await inspector.send<{ result: { value: unknown } }>('Runtime.evaluate', { expression: 'process.pid', returnByValue: true })
      if (reported.result.value !== options.pid)
        throw new Error(`port ${options.port} belongs to process ${String(reported.result.value)}, not ${options.pid}`)
      const { profile, coverage } = await ProfileClient.record(inspector, options.seconds)
      mkdirSync(dirname(options.out), { recursive: true })
      writeFileSync(options.out, JSON.stringify(profile))
      ProfileClient.print(profile, coverage, options)
    } finally {
      await inspector.send('Runtime.evaluate', { expression: "setTimeout(() => process.getBuiltinModule('node:inspector').close(), 100); 'scheduled'" })
      inspector.close()
    }
    await ProfileClient.waitClosed(options.port)
    console.log(`inspector port ${options.port} closed`)
  }

  private static parse(argv: readonly string[]): Options {
    const value = (name: string): string | undefined => {
      const index = argv.indexOf(name)
      return index < 0 ? undefined : argv[index + 1]
    }
    const pid = Number(value('--pid'))
    if (!Number.isInteger(pid) || pid <= 0)
      throw new Error('usage: profile-client.ts --pid <PID> [--seconds 30] [--port 9229] [--calls a,b] [--out file.cpuprofile]')
    const seconds = Number(value('--seconds') ?? ProfileClient.defaultSecondsConst)
    const port = Number(value('--port') ?? ProfileClient.defaultPortConst)
    const calls = value('--calls')?.split(',').filter(Boolean) ?? ProfileClient.defaultCallsConst
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const out = resolve(value('--out') ?? join('.aidocs', 'temp', 'profile-client', `${pid}-${stamp}.cpuprofile`))
    return { pid, seconds, port, calls, out }
  }

  private static async debuggerUrl(port: number): Promise<string> {
    for (let attempt = 0; attempt < ProfileClient.readyAttemptsConst; attempt++) {
      try {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { webSocketDebuggerUrl?: string }[]
        const url = targets.find(target => target.webSocketDebuggerUrl)?.webSocketDebuggerUrl
        if (url) return url
      } catch {
        // not listening yet
      }
      await new Promise(done => setTimeout(done, ProfileClient.readyDelayMillisecondsConst))
    }
    throw new Error(`no inspector on 127.0.0.1:${port}`)
  }

  private static async waitClosed(port: number): Promise<void> {
    for (let attempt = 0; attempt < ProfileClient.readyAttemptsConst; attempt++) {
      try {
        await fetch(`http://127.0.0.1:${port}/json/list`)
      } catch {
        return
      }
      await new Promise(done => setTimeout(done, ProfileClient.readyDelayMillisecondsConst))
    }
    throw new Error(`inspector port ${port} is still open`)
  }

  private static async record(inspector: InspectorConnection, seconds: number): Promise<{ profile: CpuProfile; coverage: CoverageScript[] }> {
    await inspector.send('Profiler.enable')
    await inspector.send('Profiler.setSamplingInterval', { interval: ProfileClient.samplingIntervalMicrosecondsConst })
    await inspector.send('Profiler.startPreciseCoverage', { callCount: true, detailed: false })
    await inspector.send('Profiler.takePreciseCoverage')
    await inspector.send('Profiler.start')
    await new Promise(done => setTimeout(done, seconds * 1000))
    const { profile } = await inspector.send<{ profile: CpuProfile }>('Profiler.stop')
    const { result } = await inspector.send<{ result: CoverageScript[] }>('Profiler.takePreciseCoverage')
    await inspector.send('Profiler.stopPreciseCoverage')
    await inspector.send('Profiler.disable')
    return { profile, coverage: result }
  }

  private static print(profile: CpuProfile, coverage: readonly CoverageScript[], options: Options): void {
    const byId = new Map(profile.nodes.map(node => [node.id, node]))
    const parent = new Map<number, number>()
    for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id)
    const selfCount = new Map<number, number>()
    for (const sample of profile.samples) selfCount.set(sample, (selfCount.get(sample) ?? 0) + 1)
    const total = profile.samples.length
    const percent = (count: number): string => `${(100 * count / Math.max(total, 1)).toFixed(1)}%`
    const label = (frame: CallFrame): string =>
      `${frame.functionName || '(anon)'} ${frame.url.replace(/^.*[\\/](app-client-ui|lib-orchestrator|node_modules)[\\/]/, '$1/')}:${frame.lineNumber + 1}`

    let idle = 0
    const self = new Map<string, number>()
    const inclusive = new Map<string, number>()
    const entries = new Map<string, number>()
    for (const [nodeId, count] of selfCount) {
      const node = byId.get(nodeId)!
      if (node.callFrame.functionName === '(idle)') {
        idle += count
        continue
      }
      const key = label(node.callFrame)
      self.set(key, (self.get(key) ?? 0) + count)
      const chain: CallFrame[] = []
      for (let current: number | undefined = nodeId; current !== undefined; current = parent.get(current)) chain.unshift(byId.get(current)!.callFrame)
      for (const frameKey of new Set(chain.map(label))) inclusive.set(frameKey, (inclusive.get(frameKey) ?? 0) + count)
      const named = chain.filter(frame => !ProfileClient.glueConst.has(frame.functionName || '(anon)') && !frame.url.startsWith('node:'))
      const entry = named.slice(0, 2).map(frame => `${frame.functionName || '(anon)'}:${frame.lineNumber + 1}`).join(' > ') || node.callFrame.functionName
      entries.set(entry, (entries.get(entry) ?? 0) + count)
    }

    const seconds = (profile.endTime - profile.startTime) / 1_000_000
    console.log(`pid ${options.pid}, ${seconds.toFixed(1)} s, ${total} samples, main thread busy ${percent(total - idle)}`)
    console.log(`profile ${options.out}`)
    ProfileClient.table('self time', self, percent)
    ProfileClient.table('inclusive time', inclusive, percent)
    ProfileClient.table('top-level entries', entries, percent)

    console.log('--- call counts')
    const counts = new Map<string, number>()
    for (const script of coverage) {
      if (script.url.startsWith('node:') || script.url === '') continue
      for (const fn of script.functions)
        if (options.calls.includes(fn.functionName)) counts.set(fn.functionName, (counts.get(fn.functionName) ?? 0) + (fn.ranges[0]?.count ?? 0))
    }
    for (const name of options.calls) {
      const count = counts.get(name) ?? 0
      console.log(`${String(count).padStart(9)}  ${(count / Math.max(seconds, 1)).toFixed(1).padStart(8)}/s  ${name}`)
    }
  }

  private static table(title: string, rows: ReadonlyMap<string, number>, percent: (count: number) => string): void {
    console.log(`--- ${title}`)
    for (const [key, count] of [...rows].sort((a, b) => b[1] - a[1]).slice(0, ProfileClient.topRowsConst))
      console.log(`${percent(count).padStart(6)}  ${key}`)
  }
}

await ProfileClient.main(process.argv.slice(2))
