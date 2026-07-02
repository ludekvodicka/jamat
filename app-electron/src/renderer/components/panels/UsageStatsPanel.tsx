import { IDockviewPanelProps } from 'dockview'
import { useEffect, useRef, useState, useCallback } from 'react'

const spinnerStyle = `
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
.stats-spinner {
  width: 32px; height: 32px; border: 3px solid #1a3a5c;
  border-top-color: #00d4ff; border-radius: 50%;
  animation: spin 1s linear infinite; margin-bottom: 16px;
}
.stats-dots { animation: pulse 1.5s ease-in-out infinite; }
`

export function UsageStatsPanel({ api }: IDockviewPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<'generating' | 'ready' | 'error'>('generating')
  const [errorMsg, setErrorMsg] = useState('')
  const [elapsed, setElapsed] = useState(0)

  // viewHash carries the active page + chart sub-tabs across a reload (set from the
  // dashboard's reload message) and is re-applied via the regenerated page's URL hash.
  const loadStats = useCallback((force = false, viewHash = '') => {
    setStatus('generating')
    setElapsed(0)
    const startTime = Date.now()
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - startTime) / 1000)), 1000)

    ;(window as any).electronAPI.generateStats(force).then((result: { ok: boolean; htmlPath?: string; error?: string }) => {
      clearInterval(timer)
      if (result.ok && result.htmlPath) {
        setStatus('ready')
        if (containerRef.current) {
          const existing = containerRef.current.querySelector('webview')
          if (existing) existing.remove()
          const webview = document.createElement('webview') as any
          webview.src = `file://${result.htmlPath}?t=${Date.now()}` + (viewHash ? `#${viewHash}` : '')
          webview.style.width = '100%'
          webview.style.height = '100%'
          webview.style.border = 'none'
          // The in-page "⟳ Reload" button signals us via a console message carrying the
          // current view state ("__CLAUDE_STATS_RELOAD__:page=...&otab=...&h24=..."); we
          // regenerate and pass that state back through the new page's URL hash to restore it.
          webview.addEventListener('console-message', (e: any) => {
            if (typeof e.message === 'string' && e.message.startsWith('__CLAUDE_STATS_RELOAD__')) {
              const i = e.message.indexOf(':')
              loadStats(true, i >= 0 ? e.message.slice(i + 1) : '')
            }
          })
          containerRef.current.appendChild(webview)
        }
      } else {
        setStatus('error')
        setErrorMsg(result.error || 'Unknown error')
      }
    }).catch((e: Error) => {
      clearInterval(timer)
      setStatus('error')
      setErrorMsg(e.message)
    })
  }, [])

  useEffect(() => {
    api.setTitle('📊 Usage Stats')
    loadStats()
  }, [])

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: '#0f1923' }}>
      <style>{spinnerStyle}</style>
      {status !== 'ready' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
          {status === 'generating' && (
            <>
              <div className="stats-spinner" />
              <div style={{ color: '#00d4ff', fontFamily: 'monospace', fontSize: 14, marginBottom: 8 }}>
                Generating usage statistics<span className="stats-dots">...</span>
              </div>
              <div style={{ color: '#555', fontFamily: 'monospace', fontSize: 12 }}>
                Scanning session files ({elapsed}s)
              </div>
            </>
          )}
          {status === 'error' && (
            <div style={{ color: '#f44336', fontFamily: 'monospace', fontSize: 14, textAlign: 'center', padding: 20 }}>
              <div>Failed to generate stats</div>
              <div style={{ color: '#888', marginTop: 8, fontSize: 12, maxWidth: 600, wordBreak: 'break-all' }}>{errorMsg}</div>
              <button onClick={() => loadStats()} style={{ marginTop: 16, padding: '6px 16px', background: '#1a3a5c', color: '#00d4ff', border: '1px solid #00d4ff', borderRadius: 4, cursor: 'pointer', fontFamily: 'monospace' }}>
                Retry
              </button>
            </div>
          )}
        </div>
      )}
      <div ref={containerRef} style={{ flex: 1, display: status === 'ready' ? 'block' : 'none' }} />
    </div>
  )
}
