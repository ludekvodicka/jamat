import type { ReactNode } from 'react'

/** A single column spec. `render` overrides the default `String(row[key])` cell. */
export interface Column<R> {
  key: string
  label: string
  align?: 'left' | 'right'
  render?: (row: R) => ReactNode
  width?: string
}

/**
 * Generic data table shared by every breakdown view (model / project / daily /
 * hourly / request). Each tab supplies its own column spec + formatters, which is
 * simpler and more readable than one `kind`-switch component.
 */
export function DataTable<R>({ columns, rows, rowKey, rowClassName, empty }: {
  columns: Column<R>[]
  rows: R[]
  rowKey: (row: R, i: number) => string
  rowClassName?: (row: R) => string | undefined
  empty?: string
}) {
  if (!rows.length) return <div className="usage-table-empty">{empty ?? 'No data in this window.'}</div>
  return (
    <div className="usage-table-wrap">
      <table className="usage-table">
        <thead>
          <tr>{columns.map((c) => <th key={c.key} style={{ textAlign: c.align ?? 'left', width: c.width }}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={rowKey(row, i)} className={rowClassName?.(row)}>
              {columns.map((c) => (
                <td key={c.key} style={{ textAlign: c.align ?? 'left' }}>
                  {c.render ? c.render(row) : String((row as Record<string, unknown>)[c.key] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
