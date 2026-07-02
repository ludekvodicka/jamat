import { publish } from './streams'

interface LogEntry {
  ts: number
  source: string
  message: string
}

const MAX_LOG_ENTRIES = 500
const logBuffer: LogEntry[] = []

export function logError(source: string, message: string): void {
  console.error(`[${source}]`, message)
  logBuffer.push({ ts: Date.now(), source, message })
  if (logBuffer.length > MAX_LOG_ENTRIES) logBuffer.shift()
  publish('error:log', source, message)
}

// Like logError but informational: lands in the /debug/logs buffer only.
// Does NOT broadcast 'error:log' to renderer windows, so it never pollutes
// the in-app Error Log tab (used for diagnostic taps, not real errors).
export function logInfo(source: string, message: string): void {
  console.log(`[${source}]`, message)
  logBuffer.push({ ts: Date.now(), source, message })
  if (logBuffer.length > MAX_LOG_ENTRIES) logBuffer.shift()
}

export function getLogBuffer(): LogEntry[] {
  return logBuffer
}
