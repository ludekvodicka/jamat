import type { PassBrief, SnapinItem } from '../shared/snapinContract'

export class PerfStallsBrief {
  static prompt(): string {
    return 'Implement the performance task in this assigned worktree using the direct coding workflow. '
      + 'Read the brief with jamat-cli snapins pass brief --pass {pass} and follow its work.instruction and measurements. '
      + 'Record startup with jamat-cli snapins pass event --pass {pass} --kind started. '
      + 'Investigate, implement and run the project checks. Write a local UTF-8 detail file describing the change, checks and remaining measurement, '
      + 'then record jamat-cli snapins pass event --pass {pass} --kind done --outcome ready --detail-file <absolute-detail-file>. '
      + 'For a real blocker use --outcome blocked with --detail-file instead. Stop at ready for human Finish. '
      + 'Do not publish, commit, update, or run Finish yourself. Do not invoke or imitate PP pass mode or supply ppVersion. '
      + 'Pass events own presentation; do not change automation lifecycle groups or notes separately.'
  }

  static of(item: SnapinItem): PassBrief['work'] {
    const row = item.payload
    return { kind: 'perf-stall', process: row.process, name: row.name,
      build: { version: row.version, inputHash: row.inputHash, builtAt: row.builtAt },
      selfMs: row.selfMs, count: row.count, maxMs: row.maxMs, activeHours: row.activeHours,
      selfMsPerActiveHour: typeof row.selfMsPerActiveHour === 'number' ? row.selfMsPerActiveHour : null,
      profileId: row.profileId || null,
      instruction: 'Investigate this measured Jamat blocking cluster and its process profile when available. Preserve existing behavior and tests. After the fix runs on a rebuilt client (or rebuilt Host for a Host cluster), measure again with jamat-cli perf report. Compare the new inputHash and the same cluster, accounting for sampled active hours, external load and sleep exclusions. A landed worktree proves publication; it does not by itself prove the stall is fixed.' }
  }
}
