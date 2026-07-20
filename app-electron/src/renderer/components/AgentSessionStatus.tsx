import type { RemotePeer } from '../../../../core/types/remote-control'
import { useLayoutStore } from '../store/layout-store'
import { compactSuggestPct, contextLevel, contextUsedPercent } from '../utils/context-level'
import { TerminalPromptSubmitter } from '../utils/terminalPromptSubmitter'

export function AgentSessionStatus() {
  const activeId = useLayoutStore(s => s.activePanel)
  const api = useLayoutStore(s => s.dockviewApi)
  const info = useLayoutStore(s => activeId ? s.sessionRuntimeByPanel[activeId] ?? null : null)
  const phase = useLayoutStore(s => activeId ? s.terminalPhases[activeId] : undefined)
  const contextLevels = useLayoutStore(s => s.appConfig?.contextLevels)
  const panel = api?.activePanel
  if (!activeId || panel?.id !== activeId || !info) return null

  const params = panel.params as Record<string, unknown> | undefined
  const peer = params?.peer as RemotePeer | undefined
  const terminalId = params?.terminalId as string | undefined
  const remote = !!(peer && terminalId)
  if (!remote && phase !== 'running') return null

  const pct = contextUsedPercent(info)
  if (pct === null) return null
  const level = contextLevel(pct, contextLevels)
  const contextStyle = level ? { color: level.color, fontWeight: level.fontWeight } : undefined
  const formatTokens = (tokens: number): string => {
    if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`
    if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`
    return String(tokens)
  }
  const compact = () => {
    TerminalPromptSubmitter.submit(activeId, '/compact')
  }

  return (
    <span
      className="status-item"
      data-agent-session-status
      title={`${remote ? '🛰 remote session\n' : ''}Model: ${info.model}\nContext: ${info.contextTokens.toLocaleString()} / ${info.contextWindow.toLocaleString()} tokens (${pct}%)${info.effortLevel ? `\nEffort: ${info.effortLevel}` : ''}`}
      style={{ fontFamily: 'monospace', fontSize: '11px', letterSpacing: '-0.5px' }}
    >
      {remote ? '🛰 ' : ''}<span>{info.modelLabel}</span>{info.effortLevel ? ` · ${info.effortLevel}` : ''} · <span style={contextStyle}>{formatTokens(info.contextTokens)} / {formatTokens(info.contextWindow)} · {pct}%</span>
      {pct > compactSuggestPct(contextLevels) && (
        <button
          className="status-btn status-compact-btn"
          title="Compact this session — types /compact into it and runs it"
          style={level ? { background: level.color, borderColor: level.color, color: '#1a1a1a' } : undefined}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => { event.stopPropagation(); compact() }}
        >
          Compact
        </button>
      )}
    </span>
  )
}
