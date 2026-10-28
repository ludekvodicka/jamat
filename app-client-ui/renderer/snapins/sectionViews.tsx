import { useEffect, useState } from 'react'
import type { PassMode, SnapinAction, SnapinSection } from '../../../lib-orchestrator/snapins/snapinsApi.types'

export function SectionViews({ sections, onPress }: { sections: SnapinSection[]; onPress(actionId: string, itemKeys?: string[]): void }): React.JSX.Element {
  const [selected, setSelected] = useState<string[]>([])
  const selectable = sections.flatMap((section) => section.kind === 'items' ? section.groups.flatMap((group) => group.items.filter((item) => item.selectable).map((item) => item.key)) : [])
  useEffect(() => { setSelected((keys) => keys.filter((key) => selectable.includes(key))) }, [sections])
  function actions(actions: SnapinAction[], itemKey?: string): React.JSX.Element {
    return <div className="snapins__actions">{actions.map((action) => {
      let keys: string[] | undefined
      switch (action.scope) {
        case 'kind': keys = undefined; break
        case 'item': keys = itemKey === undefined ? [] : [itemKey]; break
        case 'selection': keys = selected.filter((key) => selectable.includes(key)); break
        default: throw new Error(`Unknown action scope ${action.scope satisfies never}`)
      }
      return <button type="button" key={action.id} className={`snapins__action snapins__action--${action.tone}`}
        disabled={keys?.length === 0} onClick={() => onPress(action.id, keys)}>{action.label}</button>
    })}</div>
  }
  return <>{sections.map((section, index) => {
    switch (section.kind) {
      case 'notice': return <p key={index} className={`snapins__notice snapins__notice--${section.tone}`} role={section.tone === 'error' ? 'alert' : 'status'}>{section.text}</p>
      case 'items': return <section key={index} aria-label="Items">
        {actions(section.actions)}
        {section.groups.map((group, groupIndex) => <section key={groupIndex} className="snapins__group" aria-label={group.title}>
          <h2>{group.title} {group.mode && <span className="snapins__mode">{modeText(group.mode)}</span>}</h2>
          <ul className="snapins__items">{group.items.map((item) => <li key={item.key} className={`snapins__item snapins__item--${item.tone}`}>
            <div className="snapins__item-heading">
              {item.selectable && <input type="checkbox" aria-label={`Select ${item.title}`} checked={selected.includes(item.key)} onChange={(event) => {
                setSelected((keys) => event.target.checked ? [...keys, item.key] : keys.filter((key) => key !== item.key))
              }} />}
              <span>{item.title}</span><span className="snapins__state">{item.state}</span>
              {item.mode && group.mode !== item.mode && <span className="snapins__mode">{modeText(item.mode)}</span>}
            </div>
            {item.hold && <p className="snapins__hold">{item.hold}</p>}{actions(item.actions, item.key)}
          </li>)}</ul>
        </section>)}
      </section>
      case 'progress': return <dl key={index} className="snapins__progress" aria-label="Progress">{section.rows.map((row, rowIndex) => <div key={rowIndex}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl>
      case 'log': return <ol key={index} className="snapins__log" aria-label="Log">{section.lines.map((line, lineIndex) => <li key={lineIndex} className={`snapins__log--${line.level}`}>
        <time dateTime={new Date(line.at).toISOString()}>{new Date(line.at).toLocaleTimeString()}</time> {line.text}
      </li>)}</ol>
      default: throw new Error(`Unknown snap-in section ${JSON.stringify(section satisfies never)}`)
    }
  })}</>
}

function modeText(mode: PassMode): string {
  switch (mode) {
    case 'wt': return 'WT'
    case 'wc': return 'WC'
    default: throw new Error(`Unknown pass mode ${mode satisfies never}`)
  }
}
