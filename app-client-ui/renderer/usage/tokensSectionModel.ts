import type { TopLevelSpec } from 'vega-lite'
import type { TokenCounts, TokenUsageRow } from '../../../lib-orchestrator/tokenUsage/tokenUsageApi.types'
import type { UsageChartTheme } from './poolGraphSpec'

export class TokensSectionModel {
  static total(row: TokenCounts): number { return row.input + row.output + row.cacheRead + row.cacheWrite }
  static sum(rows: readonly TokenCounts[]): TokenCounts {
    return rows.reduce((sum, row) => ({ input: sum.input + row.input, output: sum.output + row.output,
      cacheRead: sum.cacheRead + row.cacheRead, cacheWrite: sum.cacheWrite + row.cacheWrite }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  }
  static chart(rows: readonly TokenUsageRow[], title: string, theme: UsageChartTheme): TopLevelSpec {
    return { width: 'container', height: 150, background: 'transparent',
      data: { values: rows.map(row => ({ ...row, total: TokensSectionModel.total(row) })) },
      mark: { type: 'bar', color: theme.accent, cornerRadiusTopLeft: 2, cornerRadiusTopRight: 2 },
      encoding: { x: { field: 'label', type: 'ordinal', title: null, sort: 'ascending', axis: { labelAngle: 0, labelOverlap: true } },
        y: { field: 'total', aggregate: 'sum', type: 'quantitative', title: null, axis: { format: '~s', tickCount: 4 } },
        tooltip: [{ field: 'label', type: 'nominal', title }, { field: 'total', aggregate: 'sum', type: 'quantitative', title: 'Tokens', format: ',.0f' }] },
      config: { axis: { labelColor: theme.text, titleColor: theme.text, gridColor: theme.grid, domainColor: theme.grid, tickColor: theme.grid }, view: { stroke: null } } }
  }
}
