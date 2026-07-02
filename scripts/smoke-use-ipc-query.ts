/**
 * Smoke for the useIpcQuery state-machine. Targets the pure
 * `createIpcQueryRunner` factory so we don't need react / JSDOM to
 * verify the cancel / sequence / error-wrap contract.
 *
 * Run: `npx tsx scripts/smoke-use-ipc-query.ts`
 */

import { createIpcQueryRunner } from '../app-electron/src/renderer/hooks/useIpcQuery'

interface State<T> {
  data: T | null
  loading: boolean
  error: Error | null
  history: Array<{ data: T | null; loading: boolean; error: Error | null }>
}

function makeSetters<T>(state: State<T>): {
  setData: (v: T | null) => void
  setLoading: (v: boolean) => void
  setError: (v: Error | null) => void
} {
  const snapshot = () => state.history.push({ data: state.data, loading: state.loading, error: state.error })
  return {
    setData: (v) => { state.data = v; snapshot() },
    setLoading: (v) => { state.loading = v; snapshot() },
    setError: (v) => { state.error = v; snapshot() },
  }
}

async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise<void>((r) => setImmediate(r))
}

let passed = 0
let failed = 0
const failures: string[] = []

function ok(label: string, cond: boolean, detail?: string): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else {
    failed++
    failures.push(detail ? `${label} — ${detail}` : label)
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function eq<T>(label: string, actual: T, expected: T): void {
  ok(label, Object.is(actual, expected), `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`)
}

async function run(): Promise<void> {
  console.log('\n[1] Happy path: resolve with "a"')
  {
    const state: State<string> = { data: null, loading: false, error: null, history: [] }
    const runner = createIpcQueryRunner<string>(() => Promise.resolve('a'), makeSetters(state))
    runner.run()
    eq('loading true synchronously', state.loading, true)
    await flush()
    eq('data resolved', state.data, 'a')
    eq('loading false', state.loading, false)
    eq('no error', state.error, null)
  }

  console.log('\n[2] Error path: callFn rejects with Error')
  {
    const state: State<string> = { data: null, loading: false, error: null, history: [] }
    const runner = createIpcQueryRunner<string>(() => Promise.reject(new Error('boom')), makeSetters(state))
    runner.run()
    await flush()
    ok('error populated', state.error?.message === 'boom')
    eq('loading false after error', state.loading, false)
    eq('data still null', state.data, null)
  }

  console.log('\n[3] Non-Error rejection wrapped into Error')
  {
    const state: State<string> = { data: null, loading: false, error: null, history: [] }
    const runner = createIpcQueryRunner<string>(() => Promise.reject('stringy'), makeSetters(state))
    runner.run()
    await flush()
    ok('rejection wrapped as Error', state.error instanceof Error)
    eq('wrapped message', state.error?.message, 'stringy')
  }

  console.log('\n[4] Sync throw in callFn ends in error')
  {
    const state: State<string> = { data: null, loading: false, error: null, history: [] }
    const runner = createIpcQueryRunner<string>(() => { throw new Error('sync-throw') }, makeSetters(state))
    runner.run()
    eq('sync throw caught', state.error?.message, 'sync-throw')
    eq('loading false', state.loading, false)
    await flush()
  }

  console.log('\n[5] Race: slow run, then second run with fast result — late drop')
  {
    const state: State<string> = { data: null, loading: false, error: null, history: [] }
    let resolver1: ((v: string) => void) | null = null
    const slow = () => new Promise<string>((r) => { resolver1 = r })
    const fast = () => Promise.resolve('two')
    const runner = createIpcQueryRunner<string>(slow, makeSetters(state))
    runner.run() // seq=1, in flight
    runner.setCallFn(fast)
    runner.run() // seq=2, fast resolves first
    await flush()
    eq('fast resolved first', state.data, 'two')
    resolver1!('one') // late resolve from seq=1
    await flush()
    eq('late resolve dropped', state.data, 'two')
    eq('loading false', state.loading, false)
  }

  console.log('\n[6] Cancel during flight — no setter calls after cancel')
  {
    const state: State<string> = { data: null, loading: false, error: null, history: [] }
    let resolver: ((v: string) => void) | null = null
    const runner = createIpcQueryRunner<string>(
      () => new Promise<string>((r) => { resolver = r }),
      makeSetters(state),
    )
    runner.run()
    const beforeCancelCount = state.history.length
    runner.cancel()
    resolver!('after-cancel')
    await flush()
    eq('no setter calls after cancel', state.history.length, beforeCancelCount)
    eq('data unchanged', state.data, null)
  }

  console.log('\n[7] Refetch: subsequent runs bump seq, second call wins')
  {
    const state: State<string> = { data: null, loading: false, error: null, history: [] }
    let count = 0
    const runner = createIpcQueryRunner<string>(
      () => Promise.resolve(`call-${++count}`),
      makeSetters(state),
    )
    runner.run()
    await flush()
    eq('first call', state.data, 'call-1')
    runner.run()
    await flush()
    eq('after refetch', state.data, 'call-2')
  }

  console.log('\n[8] clearOnRefetch:true clears data between dep change and resolve')
  {
    const state: State<string> = { data: null, loading: false, error: null, history: [] }
    const setters = makeSetters(state)
    let resolver2: ((v: string) => void) | null = null
    const runner = createIpcQueryRunner<string>(
      () => Promise.resolve('first'),
      setters,
      { clearOnRefetch: true },
    )
    runner.run()
    await flush()
    eq('first lands', state.data, 'first')
    runner.setCallFn(() => new Promise<string>((r) => { resolver2 = r }))
    runner.run()
    eq('cleared on refetch', state.data, null)
    eq('loading true', state.loading, true)
    resolver2!('second')
    await flush()
    eq('second lands', state.data, 'second')
  }

  console.log('\n[9] clearOnRefetch:false (default) keeps stale data during refetch')
  {
    const state: State<string> = { data: null, loading: false, error: null, history: [] }
    let resolver: ((v: string) => void) | null = null
    const runner = createIpcQueryRunner<string>(
      () => Promise.resolve('first'),
      makeSetters(state),
    )
    runner.run()
    await flush()
    eq('first lands', state.data, 'first')
    runner.setCallFn(() => new Promise<string>((r) => { resolver = r }))
    runner.run()
    eq('stale data preserved', state.data, 'first')
    eq('loading true', state.loading, true)
    resolver!('second')
    await flush()
    eq('second lands', state.data, 'second')
  }

  console.log('\n[10] onResolve callback fires for committed resolves only')
  {
    const state: State<string> = { data: null, loading: false, error: null, history: [] }
    const calls: string[] = []
    let resolver1: ((v: string) => void) | null = null
    const runner = createIpcQueryRunner<string>(
      () => new Promise<string>((r) => { resolver1 = r }),
      makeSetters(state),
      { onResolve: (v) => calls.push(v) },
    )
    runner.run()
    runner.setCallFn(() => Promise.resolve('committed'))
    runner.run() // bumps seq; prior run's resolver is now stale
    await flush()
    resolver1!('stale') // would be call-1 — must not invoke onResolve
    await flush()
    eq('onResolve fired once', calls.length, 1)
    eq('onResolve received committed value', calls[0], 'committed')
  }

  console.log('\n[11] callFn returning undefined is a no-op (no resolve, no error)')
  {
    const state: State<string> = { data: null, loading: false, error: null, history: [] }
    const runner = createIpcQueryRunner<string>(() => undefined, makeSetters(state))
    runner.run()
    await flush()
    eq('data stays null', state.data, null)
    eq('loading cleared', state.loading, false)
    eq('no error', state.error, null)
  }

  console.log('\n[12] onResolve swap mid-flight uses the latest callback')
  {
    const state: State<string> = { data: null, loading: false, error: null, history: [] }
    let resolver: ((v: string) => void) | null = null
    const calls1: string[] = []
    const calls2: string[] = []
    const runner = createIpcQueryRunner<string>(
      () => new Promise<string>((r) => { resolver = r }),
      makeSetters(state),
      { onResolve: (v) => calls1.push(v) },
    )
    runner.run()
    runner.setOnResolve((v) => calls2.push(v))
    resolver!('value')
    await flush()
    eq('old onResolve not called', calls1.length, 0)
    eq('new onResolve called once', calls2.length, 1)
    eq('new onResolve got value', calls2[0], 'value')
  }

  console.log(`\n=== ${failed === 0 ? 'PASS' : 'FAIL'} (${passed} passed, ${failed} failed)`)
  if (failures.length > 0) {
    console.log('Failures:')
    for (const f of failures) console.log(`  - ${f}`)
  }
  process.exit(failed === 0 ? 0 : 1)
}

run().catch((err) => { console.error('Smoke crashed:', err); process.exit(1) })
