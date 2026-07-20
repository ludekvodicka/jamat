import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render } from '@testing-library/react'
import { AgentSessionStatus } from './AgentSessionStatus'
import { useLayoutStore } from '../store/layout-store'
import { TerminalPromptSubmitter } from '../utils/terminalPromptSubmitter'
import type { SessionModelInfo } from '../../../../core/types/session'

const CODEX_INFO: SessionModelInfo = {
  model: 'gpt-5.6-sol',
  modelLabel: 'GPT-5.6 Sol',
  contextTokens: 103147,
  contextWindow: 258400,
  effortLevel: 'max',
}

function setActiveRuntime(info: SessionModelInfo, params: Record<string, unknown> = {}, phase: 'menu' | 'running' | null = 'running'): void {
  const panel = { id: 'panel-1', params }
  useLayoutStore.setState({
    activePanel: panel.id,
    dockviewApi: { activePanel: panel } as never,
    terminalPhases: phase ? { [panel.id]: phase } : {},
    sessionRuntimeByPanel: { [panel.id]: info },
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  delete (window as any).electronAPI
  useLayoutStore.setState({
    activePanel: null,
    dockviewApi: null,
    terminalPhases: {},
    sessionRuntimeByPanel: {},
  })
})

describe('AppElectron/Src/Renderer/Components/AgentSessionStatus', () => {
  it('renders a neutral Codex model, effort, and raw occupied context', () => {
    setActiveRuntime(CODEX_INFO)
    const { container } = render(<AgentSessionStatus />)
    expect(container.textContent).toContain('GPT-5.6 Sol · max · 103k / 258k · 40%')
    expect(container.querySelector('[data-agent-session-status]')?.getAttribute('title')).toContain('Model: gpt-5.6-sol')
    const model = Array.from(container.querySelectorAll('span')).find(element => element.textContent === 'GPT-5.6 Sol')
    expect(model?.getAttribute('style')).toBeNull()
  })

  it('keeps Claude rendering and submits Compact to the active local terminal binding', () => {
    const submit = vi.spyOn(TerminalPromptSubmitter, 'submit').mockReturnValue(true)
    setActiveRuntime({
      model: 'claude-opus-4-7',
      modelLabel: 'Opus 4.7',
      contextTokens: 500000,
      contextWindow: 1000000,
      effortLevel: 'xhigh',
    })
    const { getByRole } = render(<AgentSessionStatus />)
    fireEvent.click(getByRole('button', { name: 'Compact' }))
    expect(submit).toHaveBeenCalledWith('panel-1', '/compact')
  })

  it('hides stale local runtime data while the terminal is in its menu phase', () => {
    setActiveRuntime(CODEX_INFO, {}, 'menu')
    const { container } = render(<AgentSessionStatus />)
    expect(container.querySelector('[data-agent-session-status]')).toBeNull()
  })

  it('swaps synchronously to no item when the active panel has no runtime snapshot', () => {
    setActiveRuntime(CODEX_INFO)
    const { container } = render(<AgentSessionStatus />)
    expect(container.querySelector('[data-agent-session-status]')).not.toBeNull()
    act(() => useLayoutStore.setState({
      activePanel: 'panel-2',
      dockviewApi: { activePanel: { id: 'panel-2', params: {} } } as never,
      terminalPhases: { 'panel-2': 'running' },
    }))
    expect(container.querySelector('[data-agent-session-status]')).toBeNull()
  })

  it('shows a remote marker and submits Compact through the viewer panel binding', () => {
    const submit = vi.spyOn(TerminalPromptSubmitter, 'submit').mockReturnValue(true)
    const peer = { id: 'peer-1', name: 'Peer 1' }
    setActiveRuntime(CODEX_INFO, { peer, terminalId: 'terminal-9' }, null)
    const { container, getByRole } = render(<AgentSessionStatus />)
    expect(container.textContent).toContain('🛰 GPT-5.6 Sol')
    fireEvent.click(getByRole('button', { name: 'Compact' }))
    expect(submit).toHaveBeenCalledWith('panel-1', '/compact')
  })
})
