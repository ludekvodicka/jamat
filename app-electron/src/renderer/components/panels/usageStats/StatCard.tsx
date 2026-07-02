/** A summary stat tile (big value + label + optional sub-text). */
export function StatCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className={`usage-stat-card${accent ? ' accent' : ''}`}>
      <div className="usage-stat-value">{value}</div>
      <div className="usage-stat-label">{label}</div>
      {sub && <div className="usage-stat-sub">{sub}</div>}
    </div>
  )
}
