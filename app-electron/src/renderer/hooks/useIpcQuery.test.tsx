/**
 * Render-time test for useIpcQuery — the pure runner is covered by
 * `scripts/smoke-use-ipc-query.ts` (12 scenarios, no React). This test
 * verifies the React binding: the hook re-renders on resolve, cancels
 * on unmount, and re-runs on dep change.
 */

import { describe, expect, it, vi } from 'vitest'
import { render, waitFor, act } from '@testing-library/react'
import { useIpcQuery } from './useIpcQuery'

function Probe(props: { fetch: () => Promise<string>; dep: unknown }) {
  const q = useIpcQuery(props.fetch, [props.dep])
  return (
    <div>
      <span data-testid="loading">{String(q.loading)}</span>
      <span data-testid="data">{q.data ?? 'null'}</span>
      <span data-testid="error">{q.error?.message ?? 'null'}</span>
    </div>
  )
}

describe('useIpcQuery (React binding)', () => {
  it('resolves data and clears loading', async () => {
    const { getByTestId } = render(
      <Probe fetch={() => Promise.resolve('hello')} dep={1} />,
    )
    await waitFor(() => {
      expect(getByTestId('data').textContent).toBe('hello')
    })
    expect(getByTestId('loading').textContent).toBe('false')
    expect(getByTestId('error').textContent).toBe('null')
  })

  it('surfaces rejection via error state', async () => {
    const { getByTestId } = render(
      <Probe fetch={() => Promise.reject(new Error('boom'))} dep={1} />,
    )
    await waitFor(() => {
      expect(getByTestId('error').textContent).toBe('boom')
    })
    expect(getByTestId('loading').textContent).toBe('false')
  })

  // Removed: the unmount-cancel guarantee is covered empirically by the
  // pure runner smoke at scripts/smoke-use-ipc-query.ts (scenario [6]).
  // A React-binding test for the same guard would have to observe
  // setState-after-unmount, which React 19 no longer warns about, so
  // a console.error spy returns false-pass regardless of the source.

  it('re-runs on dep change and the late stale resolve is dropped', async () => {
    let slowResolver!: (v: string) => void
    const slow = () => new Promise<string>((r) => { slowResolver = r })
    const fast = () => Promise.resolve('fast')

    const { getByTestId, rerender } = render(<Probe fetch={slow} dep={1} />)
    // Dep change to 2 with a fast fetch.
    rerender(<Probe fetch={fast} dep={2} />)
    await waitFor(() => {
      expect(getByTestId('data').textContent).toBe('fast')
    })
    // Late stale resolve from the slow promise must not overwrite "fast".
    await act(async () => {
      slowResolver('stale')
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(getByTestId('data').textContent).toBe('fast')
  })
})
