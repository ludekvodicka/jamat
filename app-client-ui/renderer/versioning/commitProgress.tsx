import { useEffect, useState } from 'react'

import type { VersioningCommitPhase } from '../../shared/versioningCommit'

export function CommitProgress(props: {
  phase: Extract<VersioningCommitPhase, { kind: 'running' }>
}): React.JSX.Element {
  const { phase } = props
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [])
  const progress = phase.progress
  let label: string
  if (progress === undefined) label = phase.detail ?? 'Checking selected files...'
  else if (progress.stage === 'preparing') label = 'Preparing selected files'
  else if (progress.stage === 'sending') label = 'Sending changes'
  else if (progress.stage === 'transmitting') label = 'Transmitting file data'
  else if (progress.stage === 'committing') label = 'Waiting for commit confirmation'
  else if (progress.stage === 'verifying') label = 'Verifying commit result'
  else throw new Error(`Unknown commit progress: ${JSON.stringify(progress)}`)
  const total = progress?.total ?? null
  const completed = progress?.completed ?? 0
  const measured = total !== null && total > 0
  const percent = measured ? Math.min(100, Math.floor(completed / total * 100)) : undefined
  const elapsed = Math.max(0, now - phase.startedAt)
  const sampled = progress === undefined ? 0 : progress.updatedAt - progress.stageStartedAt
  const stale = progress === undefined || now - progress.updatedAt > 10_000
  const remaining = measured && completed >= 2 && completed < total && sampled >= 2_000 && !stale
    ? sampled / completed * (total - completed) : null
  return <div className="commit-progress" aria-label="Commit progress">
    <div className="commit-progress-heading">
      <span>{label}</span>
      {percent !== undefined && <span>{percent}% of this step</span>}
    </div>
    <progress aria-label={label} max={100} value={percent} />
    <div className="commit-progress-metrics">
      {measured && <span>{completed} / {total} items</span>}
      {progress?.stage === 'transmitting' && <span>{completed} files transmitted</span>}
      <span>Elapsed {CommitProgressTime.format(elapsed)}</span>
      <span>{remaining !== null ? `About ${CommitProgressTime.format(remaining)} left in this step`
        : !measured && progress !== undefined ? 'Remaining time unavailable for this step' : 'Remaining time: estimating...'}</span>
    </div>
    {progress !== undefined && progress.groupCount > 1 && <div>{progress.groupIndex - 1} / {progress.groupCount} repositories committed</div>}
  </div>
}

class CommitProgressTime {
  static format(milliseconds: number): string {
    const seconds = Math.max(0, Math.ceil(milliseconds / 1_000))
    if (seconds < 60) return `${seconds}s`
    if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
    return `${Math.floor(seconds / 3_600)}h ${Math.floor(seconds / 60) % 60}m`
  }
}
