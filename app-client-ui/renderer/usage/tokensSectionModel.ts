import type { TopLevelSpec } from 'vega-lite'
import type { TokenAgentId, TokenCounts, TokenUsageRow } from '../../../lib-orchestrator/tokenUsage/tokenUsageApi.types'
import type { UsageChartTheme } from './poolGraphSpec'
import type { ChartReadout } from './usageChart'
import { UsageModel } from './usageModel'

export class TokensSectionModel {
  static readonly agentOrderConst: readonly TokenAgentId[] = ['claude', 'codex', 'antigravity']

  static agentColor(agentId: TokenAgentId, theme: UsageChartTheme): string {
    const index = TokensSectionModel.agentOrderConst.indexOf(agentId)
    return theme.series[index] || theme.accent
  }

  static activeAgents(rows: readonly TokenUsageRow[]): TokenAgentId[] {
    const present = new Set(rows.map(row => row.agentId))
    return TokensSectionModel.agentOrderConst.filter(agentId => present.has(agentId))
  }

  static total(row: TokenCounts): number { return row.input + row.output + row.cacheRead + row.cacheWrite }
  static sum(rows: readonly TokenCounts[]): TokenCounts {
    return rows.reduce((sum, row) => ({ input: sum.input + row.input, output: sum.output + row.output,
      cacheRead: sum.cacheRead + row.cacheRead, cacheWrite: sum.cacheWrite + row.cacheWrite }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  }
  /** One bar: its total, each agent's share when there are several, then the four counters. */
  static readout(rows: readonly TokenUsageRow[], label: string, theme?: UsageChartTheme): ChartReadout | null {
    const matching = rows.filter(row => row.label === label)
    if (matching.length === 0) return null
    const sum = TokensSectionModel.sum(matching)
    const agents = TokensSectionModel.activeAgents(matching)
    return { title: label, rows: [{ label: 'Total', value: UsageModel.tokens(TokensSectionModel.total(sum)) },
      ...agents.length > 1 ? agents.map(agentId => ({ label: UsageModel.agentLabels[agentId],
        value: UsageModel.tokens(TokensSectionModel.total(TokensSectionModel.sum(matching.filter(row => row.agentId === agentId)))),
        ...(theme ? { color: TokensSectionModel.agentColor(agentId, theme) } : {}) })) : [],
      { label: 'Input', value: UsageModel.tokens(sum.input) }, { label: 'Output', value: UsageModel.tokens(sum.output) },
      { label: 'Cache read', value: UsageModel.tokens(sum.cacheRead) }, { label: 'Cache write', value: UsageModel.tokens(sum.cacheWrite) }] }
  }
  static chart(rows: readonly TokenUsageRow[], theme: UsageChartTheme): TopLevelSpec {
    const domain = [...TokensSectionModel.agentOrderConst]
    const range = domain.map(agentId => TokensSectionModel.agentColor(agentId, theme))
    return { width: 'container', height: 150, background: 'transparent',
      data: { values: rows.map(row => ({
        ...row,
        total: TokensSectionModel.total(row),
        agentOrder: TokensSectionModel.agentOrderConst.indexOf(row.agentId),
      })) },
      mark: { type: 'bar', cornerRadiusTopLeft: 2, cornerRadiusTopRight: 2 },
      encoding: {
        x: { field: 'label', type: 'ordinal', title: null, sort: 'ascending', axis: { labelAngle: 0, labelOverlap: true } },
        y: { field: 'total', aggregate: 'sum', type: 'quantitative', title: null, axis: { format: '~s', tickCount: 4 } },
        color: { field: 'agentId', type: 'nominal', scale: { domain, range }, legend: null },
        order: { field: 'agentOrder', type: 'quantitative' },
      },
      config: { axis: { labelColor: theme.text, titleColor: theme.text, gridColor: theme.grid, domainColor: theme.grid, tickColor: theme.grid }, view: { stroke: null } } }
  }
}
