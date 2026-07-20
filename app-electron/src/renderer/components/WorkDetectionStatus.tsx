import { useEffect, useState } from 'react'
import { AgentWorkDetectorBase } from '../../../../core/agents/workDetection/agentWorkDetectorBase'
import type { AgentWorkStatus } from '../../../../core/agents/workDetection/agentWorkDetector.types'
import { useLayoutStore } from '../store/layout-store'

const STATUS_COLOR: Record<AgentWorkStatus, string> = {
  idle: '#888',
  running: '#4caf50',
  'tool-use': '#42a5f5',
  blocked: '#ef5350',
  waiting: '#ffca28',
  done: '#26a69a',
}

export function WorkDetectionStatus() {
  const setDetectionDebug = useLayoutStore((s) => s.setDetectionDebug)
  const activePanel = useLayoutStore((s) => s.activePanel)
  const terminalStatus = useLayoutStore((s) => s.terminalStatus)
  const terminalDebug = useLayoutStore((s) => s.terminalDebug)
  const [, setTick] = useState(0)

  useEffect(() => {
    setDetectionDebug(true)
    const timer = setInterval(() => setTick((n) => n + 1), 500)
    return () => { clearInterval(timer); setDetectionDebug(false) }
  }, [setDetectionDebug])

  if (!activePanel) return null
  const debug = terminalDebug[activePanel]
  if (!debug) return null

  const status = terminalStatus[activePanel] ?? 'idle'
  const report = debug.report
  const statusIsWork = AgentWorkDetectorBase.isActiveStatus(status)
  const mismatch = report.verdict !== 'unknown' && (report.verdict === 'working') !== statusIsWork
  const ageMs = Date.now() - report.timestamp
  const evidence = report.evidence.map((item) => `${item.source}:${item.signal}`).join(',') || '—'
  let verdict: string
  if (report.verdict === 'working') verdict = 'WORK'
  else if (report.verdict === 'idle') verdict = 'idle'
  else if (report.verdict === 'unknown') verdict = '?'
  else
    throw new Error(`Unknown work verdict: ${JSON.stringify(report.verdict)}`)
  const title =
    `WORK DETECTION (active terminal ${activePanel})\n` +
    `agent: ${report.agent}\n` +
    `tab status: ${status}\n` +
    `detector status: ${report.status}\n` +
    `verdict: ${report.verdict}\n` +
    `reason: ${report.reason}\n` +
    `background activity: ${report.backgroundActivity}\n` +
    (mismatch ? `⚠ MISMATCH: verdict=${report.verdict}, tab status=${status}\n` : '') +
    `evidence: ${report.evidence.length ? report.evidence.map((item) => `${item.source}:${item.signal}=${JSON.stringify(item.match)}`).join('  ') : '(none)'}\n` +
    `\n── rendered screen bottom ──\n${debug.screenTail || '(empty)'}\n` +
    `\n── rendered wide screen bottom ──\n${debug.wideScreenTail || '(empty)'}\n` +
    `\n── raw PTY tail ──\n${debug.rawTail || '(empty)'}`

  return (
    <span
      className="status-item"
      title={title}
      style={{
        fontFamily: 'monospace',
        fontSize: '11px',
        cursor: 'default',
        color: mismatch ? '#ef5350' : '#e8e8e8',
        fontWeight: mismatch ? 700 : 400,
      }}
    >
      <span style={{ color: STATUS_COLOR[status] }}>●</span>
      {' '}det:{verdict}/{status}
      {' '}<span style={{ opacity: 0.9 }}>{report.agent}[{evidence}]</span>
      {' '}<span style={{ opacity: 0.75 }}>{ageMs > 9999 ? '9s+' : `${ageMs}ms`}</span>
    </span>
  )
}
