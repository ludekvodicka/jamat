import { useEffect, useState } from 'react'

import { ErrorText } from '../../shared/errorText'
import type { ContextCompactionController, ContextCompactionStatus } from './contextCompactionController'

export function ContextCompactionHint(props: {
  id: string
  sessionId: string
  controller: Pick<ContextCompactionController, 'inspect'>
}): React.JSX.Element {
  const [text, setText] = useState('Reading automatic compaction status...')
  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const refresh = async (): Promise<void> => {
      try {
        const status = await props.controller.inspect(props.sessionId)
        if (!disposed) setText(ContextCompactionHintText.of(status, Date.now()))
      } catch (error) {
        if (!disposed) setText(`Automatic compaction status is unavailable: ${ErrorText.of(error)}`)
      }
      if (!disposed) timer = setTimeout(() => { void refresh() }, 1_000)
    }
    void refresh()
    return () => {
      disposed = true
      if (timer !== null) clearTimeout(timer)
    }
  }, [props.controller, props.sessionId])
  return <span id={props.id} role="tooltip" className="jamat-context-compaction__hint">{text}</span>
}

class ContextCompactionHintText {
  static of(status: ContextCompactionStatus, now: number): string {
    const lines = [status.reason]
    if (status.cooldown !== null) {
      lines.push(`Last compact request: ${ContextCompactionHintText.time(status.cooldown.requestedAt)}.`)
      lines.push(`Cooldown ends in ${ContextCompactionHintText.remaining(status.cooldown.expiresAt, now)}`
        + ` (${ContextCompactionHintText.time(status.cooldown.expiresAt)}).`)
      lines.push('This pause follows a request, including one that fails. Jamat does not confirm its result.')
    }
    if (status.nextCheckAt === null)
      lines.push('No start time is scheduled while this condition remains.')
    else {
      lines.push(`Next check in ${ContextCompactionHintText.remaining(status.nextCheckAt, now)}`
        + ` (${ContextCompactionHintText.time(status.nextCheckAt)}).`)
      lines.push('Compact starts then if the agent is idle, the prompt is empty, the cooldown has ended'
        + ' and fresh context is at or above the threshold.')
    }
    return lines.join('\n')
  }

  private static remaining(at: number, now: number): string {
    const seconds = Math.max(0, Math.ceil((at - now) / 1_000))
    return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
  }

  private static time(at: number): string {
    return new Date(at).toLocaleTimeString()
  }
}
