import type { TopLevelSpec } from 'vega-lite'
import type { TokenUsageRow } from '../../../lib-orchestrator/tokenUsage/tokenUsageApi.types'
import type { UsageChartTheme } from './poolGraphSpec'

export class TokensSectionModel {
  static total(row: TokenUsageRow): number { return row.input + row.output + row.cacheRead + row.cacheWrite }
  static day(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  }
  static chart(rows: readonly TokenUsageRow[], title: string, theme: UsageChartTheme): TopLevelSpec {
    return { width: 'container', height: 170, background: 'transparent',
      data: { values: rows.map(row => ({ ...row, total: TokensSectionModel.total(row) })) },
      mark: { type: 'bar', color: theme.accent },
      encoding: { x: { field: 'label', type: 'ordinal', title, sort: 'ascending' },
        y: { field: 'total', aggregate: 'sum', type: 'quantitative', title: 'Tokens' },
        tooltip: [{ field: 'label', type: 'nominal', title }, { field: 'total', aggregate: 'sum', type: 'quantitative', title: 'Tokens', format: ',.0f' }] },
      config: { axis: { labelColor: theme.text, titleColor: theme.text, gridColor: theme.grid }, view: { stroke: null } } }
  }
}
