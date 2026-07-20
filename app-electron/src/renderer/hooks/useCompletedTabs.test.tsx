import { afterEach, describe, expect, it } from 'vitest'
import { act, render } from '@testing-library/react'
import { useCompletedTabs } from './useCompletedTabs'
import { useLayoutStore } from '../store/layout-store'
import type { AgentWorkStatus } from '../../../../core/agents/workDetection/agentWorkDetector.types'

function Harness() { useCompletedTabs(); return null }

function emit(id: string, status: AgentWorkStatus, backgroundActivity?: boolean) {
  act(() => {
    window.dispatchEvent(new CustomEvent('terminal-status', { detail: { id, status, backgroundActivity } }))
  })
}

afterEach(() => {
  useLayoutStore.setState({ completedTabs: {}, activePanel: null })
})

describe('AppElectron/Src/Renderer/Hooks/UseCompletedTabs', () => {
  it('flags a background tab as completed the moment its turn finishes', () => {
    useLayoutStore.setState({ activePanel: 'other' })
    render(<Harness />)
    emit('panel-x', 'running')
    emit('panel-x', 'idle')
    expect(useLayoutStore.getState().completedTabs['panel-x']).toBe(true)
  })

  it('defers the completed badge while a background shell/sub-agent is still running', () => {
    useLayoutStore.setState({ activePanel: 'other' })
    render(<Harness />)
    emit('panel-x', 'running')
    // Turn settled to idle but a background task is still active → not truly finished yet.
    emit('panel-x', 'idle', true)
    expect(useLayoutStore.getState().completedTabs['panel-x']).toBeUndefined()
    // Background task clears → useTerminal re-emits idle without the flag → the badge lands now.
    emit('panel-x', 'idle', false)
    expect(useLayoutStore.getState().completedTabs['panel-x']).toBe(true)
  })
})
