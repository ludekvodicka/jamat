import { Fragment, useEffect, type ReactNode } from 'react'
import { isAgentId, type AgentId } from '../../../../core/types/contracts'
import type { AgentUsageSnapshot, UsageWindow } from '../../shared/types'
import { useLayoutStore } from '../store/layout-store'

interface AgentUsageValueProps {
  snapshot: AgentUsageSnapshot
}

interface UsageSegmentProps {
  label: string
  window: UsageWindow
}

export function activeUsageAgent(component: unknown, phase: unknown, agent: unknown): AgentId | null {
  if (component !== 'terminalPanel') return null
  if (phase === undefined) return null
  if (phase === 'menu') return null
  else if (phase === 'running') return isAgentId(agent) ? agent : null
  else
    throw new Error(`Unknown terminal phase: ${JSON.stringify(phase)}`)
}

function UsageSegment({ label, window }: UsageSegmentProps) {
  const filled = Math.round((window.usedPercent / 100) * 10)
  return (
    <span>
      {label}: {String(window.usedPercent).padStart(2)}% [
      <span style={{ color: 'rgba(255,255,255,0.7)' }}>{'█'.repeat(filled)}</span>
      <span style={{ color: 'rgba(255,255,255,0.2)' }}>{'░'.repeat(10 - filled)}</span>]
    </span>
  )
}

export function AgentUsageValue({ snapshot }: AgentUsageValueProps) {
  const session = snapshot.windows.find(window => window.durationMinutes === 300)
  const weekly = snapshot.windows.find(window => window.durationMinutes === 10080 && !window.model)
  const fable = snapshot.windows.find(window => window.model === 'fable')

  let providerLabel: string
  let emptyLabel: string
  let showExternalLink: boolean
  if (snapshot.agent === 'claude') {
    providerLabel = 'Claude'
    emptyLabel = 'S:? W:?'
    showExternalLink = true
  } else if (snapshot.agent === 'codex') {
    providerLabel = 'Codex'
    emptyLabel = 'W:?'
    showExternalLink = false
  } else
    throw new Error(`Unknown usage agent: ${JSON.stringify(snapshot.agent)}`)

  if (!session && !weekly && !fable)
    return <span className="status-item" style={{ color: '#888' }} title={snapshot.error ?? `${providerLabel} returned no recognized usage windows`}>{emptyLabel}</span>

  const tooltip = [
    `Provider: ${providerLabel}`,
    session ? `Session: ${session.usedPercent}%${session.resetsAt ? ` (resets ${new Date(session.resetsAt).toLocaleTimeString()})` : ''}` : null,
    weekly ? `Weekly: ${weekly.usedPercent}%${weekly.resetsAt ? ` (resets ${new Date(weekly.resetsAt).toLocaleDateString()})` : ''}` : null,
    fable ? `Fable weekly: ${fable.usedPercent}%${fable.resetsAt ? ` (resets ${new Date(fable.resetsAt).toLocaleDateString()})` : ''}` : null,
    snapshot.error ? `Last refresh: ${snapshot.error}` : null,
  ].filter(Boolean).join('\n')

  const segments: ReactNode[] = []
  if (session) segments.push(<UsageSegment key="S" label="S" window={session} />)
  if (weekly) segments.push(<UsageSegment key="W" label="W" window={weekly} />)
  if (fable) segments.push(<UsageSegment key="F" label="F" window={fable} />)

  return (
    <span className="status-item" title={tooltip} style={{ cursor: 'default', fontFamily: 'monospace', fontSize: '11px', letterSpacing: '-0.5px' }}>
      {segments.map((segment, index) => <Fragment key={index}>{index > 0 ? ', ' : null}{segment}</Fragment>)}
      {showExternalLink ? (
        <span
          style={{ cursor: 'pointer', marginLeft: 6, fontSize: 12, opacity: 0.6 }}
          title="Open usage on claude.ai"
          onClick={() => window.electronAPI?.runAction?.('open-url', 'https://claude.ai/settings/usage')}
        >↗</span>
      ) : null}
    </span>
  )
}

export function AgentUsageStatus() {
  const activeId = useLayoutStore(s => s.activePanel)
  const component = useLayoutStore(s => activeId ? s.dockviewApi?.panels.find(panel => panel.id === activeId)?.api.component : undefined)
  const phase = useLayoutStore(s => activeId ? s.terminalPhases[activeId] : undefined)
  const panelAgent = useLayoutStore(s => activeId ? s.terminalAgents[activeId] : undefined)
  const agent = activeUsageAgent(component, phase, panelAgent)
  const snapshot = useLayoutStore(s => agent ? s.usageByAgent[agent] ?? null : null)

  useEffect(() => {
    if (!window.electronAPI?.onUsageUpdate) return
    return window.electronAPI.onUsageUpdate((next) => useLayoutStore.getState().setUsageSnapshot(next))
  }, [])

  useEffect(() => {
    if (!agent || !window.electronAPI?.getUsage) return
    let cancelled = false
    const refresh = () => {
      void window.electronAPI.getUsage(agent)
        .then((next) => {
          if (!cancelled && next) useLayoutStore.getState().setUsageSnapshot(next)
        })
        .catch(() => {})
    }
    refresh()

    let interval: ReturnType<typeof setInterval> | null
    if (agent === 'claude') interval = null
    else if (agent === 'codex') interval = setInterval(refresh, 60_000)
    else
      throw new Error(`Unknown usage agent: ${JSON.stringify(agent)}`)

    return () => {
      cancelled = true
      if (interval) clearInterval(interval)
    }
  }, [agent])

  return agent && snapshot ? <AgentUsageValue snapshot={snapshot} /> : null
}
