import { IDockviewPanelProps } from 'dockview'
import { useEffect, useState, useRef } from 'react'

interface ErrorEntry {
  time: string
  source: string
  message: string
}

const errorLog: ErrorEntry[] = []
const listeners: Set<() => void> = new Set()

export function addError(source: string, message: string) {
  errorLog.push({
    time: new Date().toLocaleTimeString(),
    source,
    message
  })
  if (errorLog.length > 500) errorLog.shift()
  listeners.forEach(fn => fn())
  // Don't auto-open the Error Log tab — even routine events (tab close,
  // window unmount) end up here and the tab popping back on every close
  // was disruptive. The log is still captured in the buffer and via
  // /debug/logs; users can open the panel from the tab picker when they
  // actually want to see it.
}

export function getErrorLog(): ErrorEntry[] {
  return errorLog
}

export function ErrorLogPanel(_props: IDockviewPanelProps) {
  const [, setTick] = useState(0)
  const textRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const update = () => setTick(t => t + 1)
    listeners.add(update)
    return () => { listeners.delete(update) }
  }, [])

  const text = errorLog.map(e => `[${e.time}] [${e.source}] ${e.message}`).join('\n')

  const copyAll = () => {
    navigator.clipboard.writeText(text)
  }

  const clear = () => {
    errorLog.length = 0
    setTick(t => t + 1)
  }

  return (
    <div className="error-log-panel">
      <div className="error-log-toolbar">
        <span className="error-log-count">{errorLog.length} error{errorLog.length !== 1 ? 's' : ''}</span>
        <button className="notes-btn" onClick={copyAll}>Copy All</button>
        <button className="notes-btn" onClick={clear}>Clear</button>
      </div>
      <textarea
        ref={textRef}
        className="error-log-textarea"
        value={text || 'No errors.'}
        readOnly
        spellCheck={false}
      />
    </div>
  )
}
