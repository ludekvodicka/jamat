import { Fragment, useEffect, useRef } from 'react'
import { TAB_TYPES, TabType } from '../tab-types'

interface TabTypePickerProps {
  onSelect: (type: TabType) => void
  onClose: () => void
}

export function TabTypePicker({ onSelect, onClose }: TabTypePickerProps) {
  const ref = useRef<HTMLDivElement>(null)

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

            return (
              <Fragment key={t.id}>
                {heading && <div className={`tab-picker-section${divider ? ' tab-picker-section-divider' : ''}`}>{heading}</div>}
                <div
                  className="tab-picker-item"
                  onClick={() => { onSelect(t); onClose() }}
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
