import type { FileChangeProperties, FileChangeProperty } from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'

import './filePropertyChanges.css'

/** A node's property changes, each with its BASE and working-copy value, the way a commit publishes them. */
export function FilePropertyChanges(props: {
  properties: FileChangeProperties
  label?: string
  onClose?: () => void
}): React.JSX.Element {
  const label = props.label ?? 'Property changes'
  return <section className="file-property-changes" aria-label={label}>
    <div className="file-property-changes__heading">
      <strong>{label}</strong>
      {props.onClose && <button type="button" aria-label="Close property changes" title="Close" onClick={props.onClose}>×</button>}
    </div>
    {props.properties.changes.length > 0 ? <table>
      <thead><tr><th>Property</th><th>Change</th><th>BASE</th><th>Working copy</th></tr></thead>
      <tbody>{props.properties.changes.map((change) => <tr key={change.name}>
        <td><code>{change.name}</code></td>
        <td>{FilePropertyChangeWords.kindOf(change)}</td>
        <td>{FilePropertyChangeWords.value(change.before)}</td>
        <td>{FilePropertyChangeWords.value(change.after)}</td>
      </tr>)}</tbody>
    </table> : props.properties.detail === null && <p className="file-property-changes__note">No property values differ.</p>}
    {props.properties.detail !== null && <p className="file-property-changes__note">{props.properties.detail}</p>}
  </section>
}

export class FilePropertyChangeWords {
  static kindOf(change: FileChangeProperty): 'added' | 'removed' | 'changed' {
    if (change.before === null) return 'added'
    if (change.after === null) return 'removed'
    return 'changed'
  }

  static value(value: string | null): React.JSX.Element {
    return value === null ? <span className="file-property-changes__absent">(none)</span> : <pre>{value}</pre>
  }
}
