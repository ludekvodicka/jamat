import { describe, expect, it } from 'vitest'
import { LayoutMigration } from './layoutMigration'

describe('LayoutMigration', () => {
  it('migrates nested React usage-stat components without changing panel data', () => {
    const layout = {
      grid: {
        root: {
          data: {
            views: [
              { id: 'usage-stats-native', component: 'usageStatsNativePanel', params: { filter: 'codex' } },
              { id: 'terminal-1', component: 'terminalPanel', params: { projectDir: 'Q:/work' } },
            ],
          },
        },
      },
    }

    expect(LayoutMigration.migrateUsageStatsPanel(layout)).toBe(true)
    expect(layout.grid.root.data.views).toEqual([
      { id: 'usage-stats-native', component: 'usageStatsPanel', params: { filter: 'codex' } },
      { id: 'terminal-1', component: 'terminalPanel', params: { projectDir: 'Q:/work' } },
    ])
  })

  it('reports an unchanged layout without rewriting other components', () => {
    const layout = { panels: [{ component: 'usageStatsPanel' }, { component: 'terminalPanel' }] }
    const original = structuredClone(layout)
    expect(LayoutMigration.migrateUsageStatsPanel(layout)).toBe(false)
    expect(layout).toEqual(original)
  })

  it('accepts primitive and array roots', () => {
    expect(LayoutMigration.migrateUsageStatsPanel(null)).toBe(false)
    const layout: unknown[] = ['value', { component: 'usageStatsNativePanel' }]
    expect(LayoutMigration.migrateUsageStatsPanel(layout)).toBe(true)
    expect(layout).toEqual(['value', { component: 'usageStatsPanel' }])
  })
})
