import { Fragment, useEffect, useRef, useState } from 'react'
import { TAB_TYPES, TabType, tabAgent } from '../tab-types'
import type { AgentMeta } from '../../../../core/types/ipc-contracts'
import { showToast } from './Toast'

interface TabTypePickerProps {
  onSelect: (type: TabType) => void
  onClose: () => void
}

export function TabTypePicker({ onSelect, onClose }: TabTypePickerProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [agents, setAgents] = useState<AgentMeta[] | null>(null)

  useEffect(() => {
    // Renderer can't call `listAvailableAgents()` directly under sandbox —
    // ask main. Falls back to "everything available" when the API isn't
    // wired yet so the picker still works in dev.
    let cancelled = false
    window.electronAPI?.listAgents?.().then((list) => {
      if (!cancelled) setAgents(list)
    }).catch(() => {
      if (!cancelled) setAgents([])
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const clickHandler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('keydown', handler)
    window.addEventListener('mousedown', clickHandler)
    return () => {
      window.removeEventListener('keydown', handler)
      window.removeEventListener('mousedown', clickHandler)
    }
  }, [onClose])

  // Per-row disabled state: agent-bound entries get greyed out when their
  // binary isn't on PATH (or its adapter is stubbed). Non-agent entries
  // (browser, settings, …) are always enabled.
  //
  // While `agents === null` (fetch in flight), agent entries are
  // pessimistic-disabled so a fast click on Codex during the race window
  // doesn't create a stuck stub-tab. Claude becomes enabled the moment
  // the list resolves (typically <150ms — faster than human reaction).
  const isLoading = agents === null
  const availableAgentIds = new Set((agents ?? []).filter((a) => a.available).map((a) => a.id))
  const knownAgentIds = new Set((agents ?? []).map((a) => a.id))

  return (
    <div className="tab-picker-overlay">
      <div ref={ref} className="tab-picker">
        <div className="tab-picker-header">New Tab</div>
        {(() => {
          // A heading is emitted whenever `section` changes (rows are kept
          // section-adjacent in TAB_TYPES); the first heading skips the divider.
          let lastSection: string | undefined
          let sectionIdx = 0
          return TAB_TYPES.map((t) => {
            const newSection = !!t.section && t.section !== lastSection
            const heading = newSection ? t.section : null
            const divider = newSection && sectionIdx > 0
            if (newSection) { lastSection = t.section; sectionIdx++ }

            const agent = tabAgent(t)
            const isAgentEntry = !!agent
            const disabled = isAgentEntry && (isLoading || !availableAgentIds.has(agent))
            const isStubbed = isAgentEntry && !isLoading && knownAgentIds.has(agent) && !availableAgentIds.has(agent)
            const title = disabled
              ? (isLoading
                ? 'Loading agent availability…'
                : isStubbed
                  ? `${t.label} backend not yet implemented`
                  : `${t.label}: binary not found on PATH`)
              : undefined
            return (
              <Fragment key={t.id}>
                {heading && <div className={`tab-picker-section${divider ? ' tab-picker-section-divider' : ''}`}>{heading}</div>}
                <div
                  className={`tab-picker-item${disabled ? ' tab-picker-item-disabled' : ''}`}
                  title={title}
                  onClick={() => {
                    if (disabled) {
                      showToast('Agent unavailable', `${t.label} backend not yet implemented`)
                      return
                    }
                    onSelect(t); onClose()
                  }}
                >
                  <span className="tab-picker-icon">{t.icon}</span>
                  <span className="tab-picker-label">{t.label}</span>
                  {t.shortcut && <span className="tab-picker-shortcut">{t.shortcut}</span>}
                </div>
              </Fragment>
            )
          })
        })()}
      </div>
    </div>
  )
}
