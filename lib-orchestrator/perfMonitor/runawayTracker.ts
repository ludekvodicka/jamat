export interface RunawayObservation {
  pid: number
  startedAt: number
  image: string
  cores: number
  sessionId: string
  session: string
  sessionKind: 'agent' | 'script' | 'shell'
  idle: boolean
}
export type RunawayProcess = RunawayObservation & { minutes: number }

export class RunawayTracker {
  private readonly notify: (runaway: RunawayProcess) => void
  private readonly states: Map<string, { count: number; lastAt: number; notified: boolean }>

  constructor(notify: (runaway: RunawayProcess) => void) {
    this.notify = notify
    this.states = new Map()
  }

  update(rows: readonly RunawayObservation[], at: number, live: ReadonlySet<string>): RunawayProcess[] {
    for (const key of this.states.keys()) if (!live.has(key)) this.states.delete(key)
    const result: RunawayProcess[] = []
    const observed = new Set<string>()
    for (const row of rows) {
      const key = `${row.pid}:${row.startedAt}`
      observed.add(key)
      const state = this.states.get(key) ?? { count: 0, lastAt: 0, notified: false }
      if (at <= state.lastAt) continue
      const qualifies = row.idle && row.cores > 0.5
      state.count = qualifies ? (at - state.lastAt <= 90_000 ? state.count + 1 : 1) : 0
      state.lastAt = at
      this.states.set(key, state)
      if (state.count < 10 || state.notified) continue
      state.notified = true
      const runaway = { ...row, minutes: state.count }
      result.push(runaway)
      this.notify(runaway)
    }
    for (const [key, state] of this.states) if (!observed.has(key)) state.count = 0
    return result
  }

  reset(): void {
    for (const state of this.states.values()) state.count = 0
  }

  static notice(row: RunawayProcess, openSession: (sessionId: string) => Promise<void>): {
    sessionId: string; title: string; body: string; click: () => Promise<void>
  } {
    return { sessionId: row.sessionId, title: `Runaway process in session ${row.session}`,
      body: `${row.image} under session ${row.session} keeps ${row.cores.toFixed(1)} core busy for ${row.minutes} min while the session is idle. Open the session to inspect it; stop the child from its shell or Windows Task Manager.`,
      click: () => openSession(row.sessionId) }
  }
}
