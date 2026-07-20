import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { AgentId } from '../../../../core/types/contracts'
import type { AgentWorkDebugSnapshot, AgentWorkStatus, AgentWorkVerdict } from '../../../../core/agents/workDetection/agentWorkDetector.types'
import { useLayoutStore } from '../store/layout-store'
import { WorkDetectionStatus } from './WorkDetectionStatus'

function setDetection(agent: AgentId, status: AgentWorkStatus, verdict: AgentWorkVerdict): void {
  const snapshot: AgentWorkDebugSnapshot = {
    rawTail: '',
    screenTail: '› Working (14m 34s • esc to interrupt)',
    wideScreenTail: '› Working (14m 34s • esc to interrupt)',
    report: {
      agent,
      status,
      active: status === 'running',
      verdict,
      reason: 'evidence',
      evidence: [{ source: 'screen', signal: 'workingRow', match: '› Working (14m 34s • esc to interrupt)' }],
      backgroundActivity: false,
      timestamp: Date.now(),
    },
  }
  useLayoutStore.setState({
    activePanel: 'panel-1',
    terminalStatus: { 'panel-1': status },
    terminalDebug: { 'panel-1': snapshot },
  })
}

afterEach(() => {
  cleanup()
  useLayoutStore.setState({ activePanel: null, terminalStatus: {}, terminalDebug: {}, detectionDebug: false })
})

describe('AppElectron/Src/Renderer/Components/WorkDetectionStatus', () => {
  it('renders the Codex detector report without a Claude-side recomputation', () => {
    setDetection('codex', 'running', 'working')
    const { container } = render(<WorkDetectionStatus />)
    expect(container.textContent).toContain('det:WORK/running')
    expect(container.textContent).toContain('codex[screen:workingRow]')
    expect(container.querySelector('.status-item')?.getAttribute('title')).toContain('agent: codex')
  })

  it('does not flag an unknown conservative verdict as a mismatch', () => {
    setDetection('codex', 'running', 'unknown')
    const { container } = render(<WorkDetectionStatus />)
    expect(container.textContent).toContain('det:?/running')
    expect(container.querySelector('.status-item')?.getAttribute('title')).not.toContain('MISMATCH')
  })

  it('flags a known detector verdict that contradicts the canonical status', () => {
    setDetection('claude', 'running', 'idle')
    const { container } = render(<WorkDetectionStatus />)
    expect(container.querySelector('.status-item')?.getAttribute('title')).toContain('MISMATCH')
  })
})
