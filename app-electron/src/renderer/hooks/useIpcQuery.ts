import { useEffect, useRef, useState, useCallback, DependencyList } from 'react'

/**
 * Shared async-IPC fetch hook. Encapsulates the .then/.catch/cancel/race
 * pattern that every panel was re-implementing by hand.
 *
 * The state-machine logic lives in `createIpcQueryRunner` (pure, no React
 * deps) so it can be smoke-tested in isolation. The hook is a thin React
 * wrapper that wires `useState` / `useRef` into the runner.
 *
 * Requirements & rationale: `.aidocs/plans/2026-05-27-001-feat-use-ipc-query-hook-plan.md`.
 */

export interface UseIpcQueryOptions<T> {
  /** Initial data value before the first resolve. Default: null. */
  initial?: T | null
  /** Set true to clear `data` to `initial` whenever deps change. Default: false (keep stale data during refetch). */
  clearOnRefetch?: boolean
  /**
   * Called when a fresh result lands and is committed to state (not on
   * cancelled / superseded resolves). Lets the caller layer policy on
   * top — e.g. "user already picked" — without baking that policy into
   * the hook.
   */
  onResolve?: (data: T) => void
}

export interface UseIpcQueryResult<T> {
  data: T | null
  loading: boolean
  error: Error | null
  /** Force a re-invocation without dep change. Returns the new promise. */
  refetch: () => Promise<T> | null
}

interface RunnerSetters<T> {
  setData: (v: T | null) => void
  setLoading: (v: boolean) => void
  setError: (v: Error | null) => void
}

interface RunnerHandle<T> {
  /** Invoke the configured callFn, applying sequence/cancel rules. */
  run: () => Promise<T> | null
  /** Mark the runner cancelled — subsequent resolves never call setters. */
  cancel: () => void
  /** Swap the call function without bumping the sequence — used between renders. */
  setCallFn: (fn: () => Promise<T> | undefined) => void
  /** Swap the onResolve callback without bumping the sequence. */
  setOnResolve: (fn: ((data: T) => void) | undefined) => void
}

/**
 * Pure (React-free) factory for the hook's core state-machine. Lets the
 * smoke exercise sequence/cancel/error handling without spinning up
 * react + JSDOM.
 */
export function createIpcQueryRunner<T>(
  initialCallFn: () => Promise<T> | undefined,
  setters: RunnerSetters<T>,
  opts: { initial?: T | null; clearOnRefetch?: boolean; onResolve?: (data: T) => void } = {},
): RunnerHandle<T> {
  const { initial = null, clearOnRefetch = false } = opts
  let callFn = initialCallFn
  let onResolve = opts.onResolve
  let seq = 0
  let cancelled = false

  const run = (): Promise<T> | null => {
    const mySeq = ++seq
    setters.setLoading(true)
    setters.setError(null)
    if (clearOnRefetch) setters.setData(initial)

    let promise: Promise<T> | undefined
    try {
      promise = callFn()
    } catch (err) {
      if (mySeq === seq && !cancelled) {
        setters.setError(err instanceof Error ? err : new Error(String(err)))
        setters.setLoading(false)
      }
      return null
    }

    if (!promise) {
      if (mySeq === seq && !cancelled) setters.setLoading(false)
      return null
    }

    promise.then((result) => {
      if (mySeq !== seq || cancelled) return
      setters.setData(result)
      setters.setLoading(false)
      onResolve?.(result)
    }).catch((err) => {
      if (mySeq !== seq || cancelled) return
      setters.setError(err instanceof Error ? err : new Error(String(err)))
      setters.setLoading(false)
    })

    return promise
  }

  return {
    run,
    cancel: () => { cancelled = true },
    setCallFn: (fn) => { callFn = fn },
    setOnResolve: (fn) => { onResolve = fn },
  }
}

/**
 * Run `callFn` whenever `deps` change and surface its state. Out-of-order
 * resolves are dropped (sequence guard), and no setState happens after
 * unmount. The IPC call's typed return flows through to `data: T | null`.
 */
export function useIpcQuery<T>(
  callFn: () => Promise<T> | undefined,
  deps: DependencyList,
  opts: UseIpcQueryOptions<T> = {},
): UseIpcQueryResult<T> {
  const { initial = null, clearOnRefetch = false, onResolve } = opts

  const [data, setData] = useState<T | null>(initial)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  // The runner is created once on mount and survives across renders. We
  // patch its latest `callFn` and `onResolve` per render so closures see
  // the freshest values without bumping the sequence id.
  const runnerRef = useRef<RunnerHandle<T> | null>(null)
  if (runnerRef.current === null) {
    runnerRef.current = createIpcQueryRunner<T>(callFn, { setData, setLoading, setError }, { initial, clearOnRefetch, onResolve })
  } else {
    runnerRef.current.setCallFn(callFn)
    runnerRef.current.setOnResolve(onResolve)
  }
  const runner = runnerRef.current

  const refetch = useCallback((): Promise<T> | null => runner.run(), [runner])

  useEffect(() => {
    runner.run()
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `deps` is the caller's source of truth
  }, deps)

  useEffect(() => {
    return () => runner.cancel()
  }, [runner])

  return { data, loading, error, refetch }
}
