import { useSyncExternalStore } from 'react'

import { ScriptDuration } from '../../../../lib-orchestrator/sessionManager/scripts/scriptDuration'

/** One shared 1 s clock for every mounted row, so neither the snapshot nor the tree rebuilds per tick. */
class ElapsedClock {
  private static readonly intervalMillisecondsConst = 1_000
  private static listeners = new Set<() => void>()
  private static timer: ReturnType<typeof setInterval> | null = null
  private static now = Date.now()

  static useNow(): number {
    return useSyncExternalStore(ElapsedClock.subscribe, ElapsedClock.snapshot, ElapsedClock.snapshot)
  }

  private static subscribe(listener: () => void): () => void {
    if (ElapsedClock.listeners.size === 0) {
      ElapsedClock.now = Date.now()
      ElapsedClock.timer = setInterval(ElapsedClock.tick, ElapsedClock.intervalMillisecondsConst)
    }
    ElapsedClock.listeners.add(listener)
    return () => {
      ElapsedClock.listeners.delete(listener)
      if (ElapsedClock.listeners.size === 0 && ElapsedClock.timer !== null) {
        clearInterval(ElapsedClock.timer)
        ElapsedClock.timer = null
      }
    }
  }

  private static tick(): void {
    ElapsedClock.now = Date.now()
    for (const listener of ElapsedClock.listeners) listener()
  }

  private static snapshot(): number {
    return ElapsedClock.now
  }
}

export function ElapsedText(props: { startedAt: number }): React.JSX.Element {
  const now = ElapsedClock.useNow()
  return <span className="jamat-sessions__elapsed">{ScriptDuration.elapsedText(now - props.startedAt)}</span>
}
