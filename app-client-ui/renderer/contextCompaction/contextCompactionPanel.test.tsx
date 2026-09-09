import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SessionInfo } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { AgentSettingsSaveResult, AgentSettingsValue } from '../../shared/agentSettings'
import type { IpcResult } from '../../shared/appClientUiIpc'
import { SessionsFixtures } from '../sessions/fixtures/sessionsFixtures'
import { SessionModelStore } from '../sessionModel/sessionModelStore'
import { TerminalInputRegistry } from '../shell/terminalInputRegistry'
import { AgentSettingsStore } from './agentSettingsStore'
import { ContextCompactionPanel } from './contextCompactionPanel'
import type { ContextCompactionController, ContextCompactionStatus } from './contextCompactionController'
import { SessionCompact } from './sessionCompact'

describe('app-client-ui/renderer/contextCompaction/contextCompactionPanel', () => {
  const nowConst = 1_700_000_000_000
  let session: SessionInfo
  let settingsValue: AgentSettingsValue
  let saveAnswer: IpcResult<AgentSettingsSaveResult>
  let settings: AgentSettingsStore
  let sessionModel: SessionModelStore
  let compact: SessionCompact
  let commands: string[]
  let settingsChanged: [string, boolean][]
  let status: ContextCompactionStatus
  let controller: Pick<ContextCompactionController, 'inspect'>
  let inspections: string[]

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(nowConst)
    const source = SessionsFixtures.mixed().sessions
      .find((candidate) => candidate.sessionId === 's-working')
    if (source === undefined) throw new Error('The fixture has no working session')
    session = source
    settingsValue = { claude: { yolo: false }, codex: { yolo: false } }
    saveAnswer = { ok: true, value: { ok: true } }
    settingsChanged = []
    status = { reason: 'Waiting for the pause after the last compact request to end.',
      nextCheckAt: nowConst + 125_000,
      cooldown: { requestedAt: nowConst - 475_000, expiresAt: nowConst + 125_000 } }
    inspections = []
    controller = { inspect: (sessionId) => {
      inspections.push(sessionId)
      return Promise.resolve(status)
    } }
    settings = new AgentSettingsStore({
      read: () => Promise.resolve({ ok: true, value: settingsValue }),
      subscribe: () => () => undefined,
      setAutoCompact: (agentId, enabled) => {
        settingsChanged.push([agentId, enabled])
        return Promise.resolve(saveAnswer)
      },
      reportError: () => undefined,
    })
    settings.start()
    sessionModel = new SessionModelStore({
      read: () => Promise.resolve({
        ok: true,
        value: {
          kind: 'ok',
          info: {
            model: 'claude-sonnet-4-5-20260101',
            modelLabel: 'Sonnet 4.5',
            effortLevel: 'high',
            contextTokens: 160_000,
            contextWindow: 200_000,
          },
        },
      }),
      reportError: () => undefined,
    }, () => nowConst)
    await sessionModel.readNow(session.sessionId)
    commands = []
    const inputs = new TerminalInputRegistry()
    inputs.register(session.sessionId, {
      writable: () => true,
      write: (data) => {
        commands.push(data)
        return true
      },
      focus: () => undefined,
    })
    compact = new SessionCompact(inputs, {
      claimAutomatic: () => Promise.resolve({ ok: true, value: true }),
      cooldown: () => Promise.resolve({ ok: true, value: null }),
      noteManual: () => Promise.resolve({ ok: true, value: undefined }),
      reportError: () => undefined,
    })
    await vi.advanceTimersByTimeAsync(0)
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  function draw(now: number | null = nowConst): HTMLElement {
    return render(
      <ContextCompactionPanel
        session={session}
        sessionModel={sessionModel}
        settings={settings}
        compact={compact}
        controller={controller}
        now={now ?? undefined}
      />,
    ).container
  }

  it('draws a full-width warning with compact and the provider checkbox', () => {
    const container = draw()

    expect(container.querySelector('[aria-label="Context usage warning"]')).not.toBeNull()
    expect(container.textContent).toContain(
      'Context is at 80%: 160,000 of 200,000 tokens. Compact is recommended.',
    )
    expect(container.textContent).toContain('Auto-compact all Claude sessions at 40%')
  })

  it('uses the shared manual compact operation', async () => {
    const container = draw()
    const button = container.querySelector('button')
    if (!(button instanceof HTMLButtonElement)) throw new Error('The panel drew no Compact button')

    fireEvent.click(button)
    await vi.advanceTimersByTimeAsync(100)

    expect(commands).toEqual(['/compact', '\r'])
  })

  it('updates only this provider auto-compact switch', async () => {
    const container = draw()
    const checkbox = container.querySelector('input[type="checkbox"]')
    if (!(checkbox instanceof HTMLInputElement)) throw new Error('The panel drew no checkbox')

    fireEvent.click(checkbox)

    await waitFor(() => expect(checkbox.checked).toBe(true))
    expect(settingsChanged).toEqual([['claude', true]])
  })

  it('keeps the old switch and shows a refused save', async () => {
    saveAnswer = {
      ok: true,
      value: { ok: false, code: 'section-damaged', detail: 'Repair config.json first.' },
    }
    const container = draw()
    const checkbox = container.querySelector('input[type="checkbox"]')
    if (!(checkbox instanceof HTMLInputElement)) throw new Error('The panel drew no checkbox')

    fireEvent.click(checkbox)

    await waitFor(() => expect(container.textContent).toContain('Repair config.json first.'))
    expect(checkbox.checked).toBe(false)
  })

  it('draws nothing after the session ends', () => {
    session = { ...session, life: 'ended' }

    expect(draw().textContent).toBe('')
  })

  it('hides itself when an unchanged reading becomes stale', async () => {
    const container = draw(null)
    expect(container.querySelector('[aria-label="Context usage warning"]')).not.toBeNull()

    await act(async () => vi.advanceTimersByTimeAsync(40_000))

    expect(container.querySelector('[aria-label="Context usage warning"]')).toBeNull()
  })

  it('shows the actual cooldown on hover, counts down and stops polling when closed', async () => {
    const container = draw()
    const checkbox = container.querySelector('input')!
    expect(inspections).toEqual([])
    fireEvent.mouseEnter(checkbox)
    await act(async () => { await Promise.resolve() })
    const tooltip = container.querySelector('[role="tooltip"]')!
    expect(tooltip.textContent).toContain('Cooldown ends in 2m 05s')
    expect(tooltip.textContent).toContain('Next check in 2m 05s')
    expect(tooltip.textContent).toContain('including one that fails')
    expect(checkbox.getAttribute('aria-describedby')).toBe(tooltip.id)
    expect(inspections).toEqual([session.sessionId])
    await act(async () => vi.advanceTimersByTimeAsync(1_000))
    expect(tooltip.textContent).toContain('Cooldown ends in 2m 04s')
    fireEvent.mouseLeave(checkbox)
    const count = inspections.length
    await act(async () => vi.advanceTimersByTimeAsync(5_000))
    expect(inspections).toHaveLength(count)
    expect(container.querySelector('[role="tooltip"]')).toBeNull()
    expect(commands).toEqual([])
    expect(settingsChanged).toEqual([])
  })

  it('explains an unsent prompt on keyboard focus without promising a start time', async () => {
    status = { reason: 'The prompt has unsent text. Submit or clear it before automatic compaction.',
      nextCheckAt: null, cooldown: null }
    const container = draw()
    const checkbox = container.querySelector('input')!
    fireEvent.focus(checkbox)
    await act(async () => { await Promise.resolve() })
    expect(container.querySelector('[role="tooltip"]')?.textContent).toContain('The prompt has unsent text.')
    expect(container.querySelector('[role="tooltip"]')?.textContent).toContain('No start time is scheduled')
    fireEvent.keyDown(checkbox, { key: 'Escape' })
    expect(container.querySelector('[role="tooltip"]')).toBeNull()
  })

  it('reports an unavailable cooldown channel instead of inventing a countdown', async () => {
    controller = { inspect: () => Promise.reject(new Error('Main process is unavailable')) }
    const container = draw()
    fireEvent.mouseEnter(container.querySelector('input')!)
    await act(async () => { await Promise.resolve() })
    expect(container.querySelector('[role="tooltip"]')?.textContent)
      .toBe('Automatic compaction status is unavailable: Main process is unavailable')
    expect(commands).toEqual([])
  })
})
