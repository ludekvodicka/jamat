export class LayoutMigration {
  static migrateUsageStatsPanel(value: unknown): boolean {
    if (Array.isArray(value)) {
      let changed = false
      for (const item of value)
        if (LayoutMigration.migrateUsageStatsPanel(item)) changed = true
      return changed
    }
    if (!value || typeof value !== 'object') return false

    const record = value as Record<string, unknown>
    let changed = false
    for (const [key, child] of Object.entries(record)) {
      if (key === 'component' && child === 'usageStatsNativePanel') {
        record[key] = 'usageStatsPanel'
        changed = true
      } else if (LayoutMigration.migrateUsageStatsPanel(child)) changed = true
    }
    return changed
  }
}
