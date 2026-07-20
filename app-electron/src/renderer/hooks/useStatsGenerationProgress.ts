import { useCallback, useEffect, useRef, useState } from 'react'
import type { StatsGenerationProgress, StatsGenerationProgressUpdate } from '../../../../core/types/stats'

export interface StatsGenerationProgressState {
  progress: StatsGenerationProgressUpdate | null
  elapsedSeconds: number
  running: boolean
  begin: () => string
  finish: () => void
}

export function formatStatsGenerationProgress(progress: StatsGenerationProgressUpdate | null): string {
  if (!progress) return 'Starting…'
  const count = progress.total !== undefined && progress.total > 0
    ? ` ${StatsGenerationProgressFormatter.number(progress.current ?? 0)} / ${StatsGenerationProgressFormatter.number(progress.total)}`
    : ''
  if (progress.phase === 'starting') return 'Starting…'
  else if (progress.phase === 'claudeDiscover') return `Claude: finding JSONL files${count}`
  else if (progress.phase === 'claudeCheck') return `Claude: checking JSONL files${count}`
  else if (progress.phase === 'claudeParse') return `Claude: parsing changed files${count}`
  else if (progress.phase === 'claudeBuild') return `Claude: building statistics${count}`
  else if (progress.phase === 'codexDiscover') return `Codex: finding rollouts${count}`
  else if (progress.phase === 'codexCheck') return `Codex: checking rollouts${count}`
  else if (progress.phase === 'codexParse') return `Codex: indexing rollouts${count}`
  else if (progress.phase === 'codexBuild') return `Codex: building statistics${count}`
  else if (progress.phase === 'merge') return 'Merging Claude and Codex statistics'
  else if (progress.phase === 'write') return 'Writing statistics cache'
  else if (progress.phase === 'complete') return 'Statistics loaded'
  else
    throw new Error(`Unknown stats generation phase: ${JSON.stringify(progress.phase)}`)
}

export function useStatsGenerationProgress(): StatsGenerationProgressState {
  const activeRequestId = useRef<string | null>(null)
  const startedAt = useRef(0)
  const mounted = useRef(true)
  const [progress, setProgress] = useState<StatsGenerationProgressUpdate | null>(null)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [running, setRunning] = useState(false)

  const begin = useCallback((): string => {
    const requestId = StatsGenerationProgressFormatter.requestId()
    activeRequestId.current = requestId
    startedAt.current = Date.now()
    setProgress({ phase: 'starting' })
    setElapsedSeconds(0)
    setRunning(true)
    return requestId
  }, [])

  const finish = useCallback((): void => {
    activeRequestId.current = null
    if (mounted.current) setRunning(false)
  }, [])

  useEffect(() => window.electronAPI.onStatsProgress((event: StatsGenerationProgress) => {
    if (event.requestId !== activeRequestId.current) return
    const { requestId: _, ...update } = event
    if (mounted.current) setProgress(update)
  }), [])

  useEffect(() => () => {
    mounted.current = false
    activeRequestId.current = null
  }, [])

  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => setElapsedSeconds(Math.floor((Date.now() - startedAt.current) / 1000)), 1000)
    return () => window.clearInterval(timer)
  }, [running])

  return { progress, elapsedSeconds, running, begin, finish }
}

class StatsGenerationProgressFormatter {
  static number(value: number): string {
    return value.toLocaleString('en-US')
  }

  static requestId(): string {
    if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`
  }
}
