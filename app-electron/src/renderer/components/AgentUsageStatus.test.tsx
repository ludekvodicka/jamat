import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import type { AgentUsageSnapshot } from '../../shared/types'
import { useLayoutStore } from '../store/layout-store'
import { activeUsageAgent, AgentUsageStatus, AgentUsageValue } from './AgentUsageStatus'

function snapshot(agent: 'claude' | 'codex', windows: AgentUsageSnapshot['windows'], error?: string): AgentUsageSnapshot {
  return { agent, fetchedAt: 1, windows, ...(error ? { error } : {}) }
}

afterEach(() => {
  delete (window as any).electronAPI
  useLayoutStore.setState({
    dockviewApi: null,
    activePanel: null,
    terminalPhases: {},
    terminalAgents: {},
    usageByAgent: {},
  })
})

describe('AppElectron/Src/Renderer/Components/AgentUsageStatus', () => {
  it('selects only a valid agent in a running local terminal', () => {
    expect(activeUsageAgent('terminalPanel', 'running', 'claude')).toBe('claude')
    expect(activeUsageAgent('terminalPanel', 'running', 'codex')).toBe('codex')
    expect(activeUsageAgent('terminalPanel', 'running', 'unknown')).toBeNull()
  })

  it('hides usage in menus, transitions, shells, stats, and remote viewers', () => {
    expect(activeUsageAgent('terminalPanel', 'menu', 'claude')).toBeNull()
    expect(activeUsageAgent('terminalPanel', undefined, 'codex')).toBeNull()
    expect(activeUsageAgent('usageStatsPanel', 'running', 'claude')).toBeNull()
    expect(activeUsageAgent('settingsPanel', 'running', 'claude')).toBeNull()
    expect(activeUsageAgent('remoteViewerPanel', 'running', 'codex')).toBeNull()
  })

  it('fails loudly on an unknown terminal phase', () => {
    expect(() => activeUsageAgent('terminalPanel', 'paused', 'codex')).toThrow('Unknown terminal phase')
  })

  it('renders only the real Codex weekly window when no session window exists', () => {
    const { container } = render(<AgentUsageValue snapshot={snapshot('codex', [{ durationMinutes: 10080, usedPercent: 21, resetsAt: null }])} />)
    expect(container.textContent).toContain('W: 21%')
    expect(container.textContent).not.toContain('S:')
  })

  it('renders both returned Codex windows', () => {
    const { container } = render(<AgentUsageValue snapshot={snapshot('codex', [
      { durationMinutes: 300, usedPercent: 10, resetsAt: null },
      { durationMinutes: 10080, usedPercent: 21, resetsAt: null },
    ])} />)
    expect(container.textContent).toContain('S: 10%')
    expect(container.textContent).toContain('W: 21%')
  })

  it('does not invent a Codex session window in its error state', () => {
    const { container } = render(<AgentUsageValue snapshot={snapshot('codex', [], 'offline')} />)
    expect(container.textContent).toBe('W:?')
    expect(container.textContent).not.toContain('S:')
    expect(container.querySelector('[title="offline"]')).not.toBeNull()
  })

  it('renders the Fable weekly segment distinctly from the overall weekly one', () => {
    const { container } = render(<AgentUsageValue snapshot={snapshot('claude', [
      { durationMinutes: 300, usedPercent: 28, resetsAt: null },
      { durationMinutes: 10080, usedPercent: 57, resetsAt: null },
      { durationMinutes: 10080, usedPercent: 79, resetsAt: null, model: 'fable' },
    ])} />)
    expect(container.textContent).toContain('S: 28%')
    expect(container.textContent).toContain('W: 57%')
    expect(container.textContent).toContain('F: 79%')
  })

  it('omits the Fable segment when the API returns no Fable window', () => {
    const { container } = render(<AgentUsageValue snapshot={snapshot('claude', [
      { durationMinutes: 300, usedPercent: 4, resetsAt: null },
      { durationMinutes: 10080, usedPercent: 12, resetsAt: null },
    ])} />)
    expect(container.textContent).not.toContain('F:')
  })

  it('keeps the verified external usage link Claude-only', () => {
    ;(window as any).electronAPI = { runAction: () => {} }
    const claude = render(<AgentUsageValue snapshot={snapshot('claude', [{ durationMinutes: 300, usedPercent: 4, resetsAt: null }])} />)
    expect(claude.getByTitle('Open usage on claude.ai')).not.toBeNull()
    claude.unmount()
    const codex = render(<AgentUsageValue snapshot={snapshot('codex', [{ durationMinutes: 10080, usedPercent: 4, resetsAt: null }])} />)
    expect(codex.queryByTitle('Open usage on claude.ai')).toBeNull()
  })

  it('switches snapshots with the active running terminal without stale provider data', () => {
    ;(window as any).electronAPI = {
      getUsage: vi.fn().mockResolvedValue(null),
      onUsageUpdate: vi.fn().mockReturnValue(() => {}),
    }
    useLayoutStore.setState({
      dockviewApi: { panels: [{ id: 'panel-1', api: { component: 'terminalPanel' } }] } as any,
      activePanel: 'panel-1',
      terminalPhases: { 'panel-1': 'running' },
      terminalAgents: { 'panel-1': 'claude' },
      usageByAgent: {
        claude: snapshot('claude', [{ durationMinutes: 300, usedPercent: 12, resetsAt: null }]),
        codex: snapshot('codex', [{ durationMinutes: 10080, usedPercent: 7, resetsAt: null }]),
      },
    })

    const view = render(<AgentUsageStatus />)
    expect(view.container.textContent).toContain('S: 12%')
    act(() => useLayoutStore.getState().setTerminalAgent('panel-1', 'codex'))
    expect(view.container.textContent).toContain('W:  7%')
    expect(view.container.textContent).not.toContain('S:')
  })
})
