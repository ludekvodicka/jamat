import { useCallback, useEffect, useId, useState, useSyncExternalStore } from 'react'

import type { SessionInfo } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { SessionContextUsage } from '../sessionModel/sessionContextUsage'
import type { SessionModelStore } from '../sessionModel/sessionModelStore'
import type { AgentSettingsStore } from './agentSettingsStore'
import { ContextCompactionPanelModel } from './contextCompactionPanelModel'
import type { ContextCompactionController } from './contextCompactionController'
import { ContextCompactionHint } from './contextCompactionHint'
import type { SessionCompact } from './sessionCompact'
import './contextCompactionPanel.css'

export function ContextCompactionPanel(props: {
  session: SessionInfo | null
  sessionModel: SessionModelStore
  settings: AgentSettingsStore
  compact: SessionCompact
  controller: Pick<ContextCompactionController, 'inspect'>
  now?: number
}): React.JSX.Element | null {
  const sessionId = props.session?.sessionId ?? null
  const subscribeModel = useCallback(
    (onChanged: () => void) => props.sessionModel.subscribe(onChanged),
    [props.sessionModel],
  )
  const currentModel = useCallback(
    () => sessionId === null ? null : props.sessionModel.readingFor(sessionId),
    [props.sessionModel, sessionId],
  )
  const reading = useSyncExternalStore(subscribeModel, currentModel, currentModel)
  const subscribeSettings = useCallback(
    (onChanged: () => void) => props.settings.subscribe(onChanged),
    [props.settings],
  )
  const currentSettings = useCallback(() => props.settings.current(), [props.settings])
  const settings = useSyncExternalStore(subscribeSettings, currentSettings, currentSettings)
  const [saving, setSaving] = useState(false)
  const [hintOpen, setHintOpen] = useState(false)
  const hintId = useId()
  const [error, setError] = useState<string | null>(null)
  const [, setAgeRevision] = useState(0)
  useEffect(() => {
    setSaving(false)
    setError(null)
    setHintOpen(false)
  }, [sessionId])
  useEffect(() => {
    if (props.now !== undefined || reading === null) return
    const remaining = SessionContextUsage.freshMillisecondsRemaining(Date.now() - reading.readAt)
    if (remaining === 0) return
    const timer = setTimeout(() => setAgeRevision((revision) => revision + 1), remaining)
    return () => clearTimeout(timer)
  }, [props.now, reading])
  const panel = ContextCompactionPanelModel.of(
    props.session,
    reading,
    settings.value,
    props.now,
  )
  if (panel === null || sessionId === null) return null

  const setAutoCompact = async (enabled: boolean): Promise<void> => {
    setSaving(true)
    setError(null)
    const result = await props.settings.setAutoCompact(panel.agentId, enabled)
    setSaving(false)
    if (!result.ok) setError(result.detail)
  }

  return (
    <aside className="jamat-context-compaction" aria-label="Context usage warning">
      <p className="jamat-context-compaction__message" role="status" aria-live="polite">
        {panel.message}
      </p>
      <div className="jamat-context-compaction__actions">
        <button
          className="jamat-context-compaction__compact"
          type="button"
          onClick={() => props.compact.manual(sessionId)}
        >
          Compact
        </button>
        <span
          className="jamat-context-compaction__auto-hint"
          onMouseEnter={() => setHintOpen(true)}
          onMouseLeave={() => setHintOpen(false)}
          onFocus={() => setHintOpen(true)}
          onBlur={() => setHintOpen(false)}
          onKeyDown={(event) => { if (event.key === 'Escape') setHintOpen(false) }}
        >
          <label className="jamat-context-compaction__auto">
            <input
              type="checkbox"
              aria-describedby={hintOpen ? hintId : undefined}
              checked={panel.autoCompactEnabled}
              disabled={saving}
              onChange={(event) => void setAutoCompact(event.currentTarget.checked)}
            />
            {`Auto-compact all ${panel.agentLabel} sessions at ${panel.autoCompactPercent}%`}
          </label>
          {hintOpen && <ContextCompactionHint
            id={hintId}
            sessionId={sessionId}
            controller={props.controller}
          />}
        </span>
      </div>
      {error !== null && <p className="jamat-context-compaction__error">{error}</p>}
    </aside>
  )
}
