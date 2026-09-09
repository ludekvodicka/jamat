import { fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { DebugTimeFormat } from '../debugTimeFormat'
import { RateDebugFixtures } from './fixtures/rateDebugFixtures'
import { RateClaudeSection, RateCodexSection, RateDebugSection } from './rateDebugSection'

describe('app-client-ui/renderer/debugWindow/sections/rate/rateDebugSection', () => {
  afterEach(() => {
    RateDebugFixtures.removeBridge()
  })

  it('reads once when the root opens and draws only the shared poll facts', async () => {
    const bridge = RateDebugFixtures.installBridge()
    const view = render(<RateDebugSection />)

    await waitFor(() => expect(bridge.reads).toBe(1))
    expect(view.getByText('600000 ms')).toBeInTheDocument()
    expect(view.getByText('180000 ms')).toBeInTheDocument()
    expect(view.queryByRole('heading', { name: 'Codex' })).toBeNull()
    expect(view.queryByRole('heading', { name: 'Claude' })).toBeNull()
  })

  it('draws Codex without Claude in the Codex node', async () => {
    RateDebugFixtures.installBridge()
    const view = render(<RateCodexSection />)

    await waitFor(() => expect(view.getByRole('heading', { name: 'Codex' })).toBeInTheDocument())
    expect(view.queryByRole('heading', { name: 'Claude' })).toBeNull()
    expect(view.getByText('7%')).toBeInTheDocument()
    expect(view.getByText(/"rate_limits"/)).toBeInTheDocument()
    expect(view.queryByText('opus')).toBeNull()
    expect(view.queryByText(/"five_hour"/)).toBeNull()
  })

  it('draws Claude without Codex in the Claude node', async () => {
    RateDebugFixtures.installBridge()
    const view = render(<RateClaudeSection />)

    await waitFor(() => expect(view.getByRole('heading', { name: 'Claude' })).toBeInTheDocument())
    expect(view.queryByRole('heading', { name: 'Codex' })).toBeNull()
    expect(view.getByText('opus')).toBeInTheDocument()
    expect(view.getByText(/"five_hour"/)).toBeInTheDocument()
    expect(view.queryByText(/"rate_limits"/)).toBeNull()
  })

  /*
   * The point of this screen. The widget picks the session and the plain weekly window out of the
   * answer; the model-scoped ones it leaves behind are exactly what somebody opens this for, so every
   * window the API returned is in the table.
   */
  it('draws every window the API returned, the model-scoped ones included', async () => {
    RateDebugFixtures.installBridge()
    const view = render(<RateClaudeSection />)

    await waitFor(() => expect(view.getByText('opus')).toBeInTheDocument())
    expect(view.getByText('sonnet')).toBeInTheDocument()
    expect(view.getByText('61%')).toBeInTheDocument()
    expect(view.getByText('42%')).toBeInTheDocument()
    expect(view.getByText('12%')).toBeInTheDocument()
    expect(view.getByText('3%')).toBeInTheDocument()
    // The fact with no window of its own travels beside them.
    expect(view.getByText('Extra usage')).toBeInTheDocument()
    expect(view.getByText('$12.40 of $50.00 used')).toBeInTheDocument()
  })

  it('says when the OAuth token ran out, as a time and as a duration', async () => {
    RateDebugFixtures.installBridge()
    const first = render(<RateClaudeSection />)

    await waitFor(() => expect(first.getByText(/expired 3m 0s ago/)).toBeInTheDocument())
    first.unmount()
    RateDebugFixtures.removeBridge()

    RateDebugFixtures.installBridge(RateDebugFixtures.status({
      providers: {
        claude: RateDebugFixtures.claude({
          oauthExpiresAt: RateDebugFixtures.nowConst + 42 * 60_000,
        }),
        codex: RateDebugFixtures.codex(),
      },
    }))
    const second = render(<RateClaudeSection />)

    await waitFor(() => expect(second.getByText(/expires in 42m 0s/)).toBeInTheDocument())
  })

  // In `stale` the two part, and that gap is the reading; one "last updated" would hide it.
  it('draws the last attempt and the last success as two readings', async () => {
    RateDebugFixtures.installBridge()
    const view = render(<RateClaudeSection />)

    await waitFor(() => expect(view.getByText(/20s ago/)).toBeInTheDocument())
    expect(view.getAllByText('Last attempt')).toHaveLength(1)
    expect(view.getAllByText('Last success')).toHaveLength(1)
    expect(view.getByText(/15m 0s ago/)).toBeInTheDocument()
    expect(view.getByText(/^stale - OAuth token expired/)).toBeInTheDocument()
  })

  it('refreshes the monitor and reads the status again', async () => {
    const bridge = RateDebugFixtures.installBridge()
    const view = render(<RateDebugSection />)
    await waitFor(() => expect(bridge.reads).toBe(1))

    fireEvent.click(view.getByRole('button', { name: 'Refresh' }))

    await waitFor(() => expect(bridge.refreshes).toBe(1))
    await waitFor(() => expect(bridge.reads).toBe(2))
  })

  // No timer here on purpose: the push is the only thing besides the button that moves this screen.
  it('reads again when the monitor says its content moved', async () => {
    const bridge = RateDebugFixtures.installBridge()
    render(<RateDebugSection />)
    await waitFor(() => expect(bridge.reads).toBe(1))

    bridge.pushChanged()

    await waitFor(() => expect(bridge.reads).toBe(2))
  })

  /*
   * Through the reader every push-plus-read pair in this window uses, so the sentence is the reader's
   * and the retries are bounded. It used to subscribe to the push itself and dispatch a full read per
   * one, with no coalescing, no single-flight and no give-up.
   */
  it('says so when the channel does not answer, rather than drawing nothing', async () => {
    const bridge = {
      rateMonitor: {
        debugStatus: () => Promise.resolve({ ok: false as const, error: 'the pipe closed' }),
        refresh: () => Promise.resolve({ ok: false as const, error: 'the pipe closed' }),
      },
      onRateChanged: () => () => undefined,
    }
    ;(window as unknown as { appClient: unknown }).appClient = bridge
    const view = render(<RateDebugSection />)

    await waitFor(() => expect(view.getByRole('alert'))
      .toHaveTextContent(/The rate limits debug status could not be read/), { timeout: 5_000 })
    expect(view.getByText('Nothing has been read from the monitor yet.')).toBeInTheDocument()
  })

  // The body underneath the mapped numbers, whole: the buckets nothing maps are what it is drawn for.
  it('draws the whole Claude response body in the Claude node', async () => {
    RateDebugFixtures.installBridge()
    const view = render(<RateClaudeSection />)

    await waitFor(() => expect(view.getByText(/"five_hour"/)).toBeInTheDocument())
    const drawn = view.container.textContent ?? ''
    expect(drawn).toContain('"nimbus_quill"')
    expect(drawn).toContain('"member_dashboard_available": false')
    expect(drawn).not.toContain('"rate_limits"')
  })

  it('says a provider with no window has none, rather than drawing an empty table', async () => {
    RateDebugFixtures.installBridge(RateDebugFixtures.status({
      providers: {
        claude: RateDebugFixtures.claude({ state: { kind: 'never-read' }, raw: null, extras: [] }),
        codex: RateDebugFixtures.codex({
          state: { kind: 'unconfigured', reason: 'codex is not installed' },
          raw: null,
        }),
      },
    }))
    const view = render(<RateCodexSection />)

    await waitFor(() => expect(view.getByText('unconfigured - codex is not installed'))
      .toBeInTheDocument())
    expect(view.queryByRole('table')).toBeNull()
    expect(view.getByText('nothing has been read yet')).toBeInTheDocument()
    expect(view.getByText('No window was returned.')).toBeInTheDocument()
    expect(view.queryByText('never read')).toBeNull()
  })

  it('stamps the headline with the moment the main process composed the status', async () => {
    RateDebugFixtures.installBridge()
    const view = render(<RateDebugSection />)

    await waitFor(() => expect(view.getByText(
      `Rate limits · composed ${DebugTimeFormat.at(RateDebugFixtures.nowConst)}`,
    )).toBeInTheDocument())
  })
})
