import { IDockviewPanelProps } from 'dockview'
import { useEffect, useRef, useState } from 'react'

interface BrowserPanelParams {
  tabType?: string
  url?: string
}

export function BrowserPanel({ api, params }: IDockviewPanelProps<BrowserPanelParams>) {
  const containerRef = useRef<HTMLDivElement>(null)
  const webviewRef = useRef<any>(null)
  const [url, setUrl] = useState(params.url ?? 'https://www.google.com')
  const [inputUrl, setInputUrl] = useState(url)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!containerRef.current) return
    const webview = document.createElement('webview') as any
    webview.src = url
    webview.style.width = '100%'
    webview.style.height = '100%'
    webview.style.border = 'none'
    webview.setAttribute('allowpopups', 'false')
    webviewRef.current = webview

    webview.addEventListener('did-navigate', (e: any) => {
      setUrl(e.url)
      setInputUrl(e.url)
      setCanGoBack(webview.canGoBack())
      setCanGoForward(webview.canGoForward())
      api.updateParameters({ url: e.url })
      const title = webview.getTitle()
      if (title) api.setTitle(title)
    })

    webview.addEventListener('did-navigate-in-page', (e: any) => {
      setUrl(e.url)
      setInputUrl(e.url)
      setCanGoBack(webview.canGoBack())
      setCanGoForward(webview.canGoForward())
      api.updateParameters({ url: e.url })
    })

    webview.addEventListener('page-title-updated', (e: any) => {
      api.setTitle(e.title)
    })

    webview.addEventListener('did-start-loading', () => setLoading(true))
    webview.addEventListener('did-stop-loading', () => setLoading(false))

    containerRef.current.appendChild(webview)
    return () => {
      if (containerRef.current?.contains(webview)) containerRef.current.removeChild(webview)
    }
  }, [])

  const navigate = (targetUrl: string) => {
    if (!webviewRef.current) return
    let finalUrl = targetUrl
    if (!finalUrl.match(/^https?:\/\//)) finalUrl = 'https://' + finalUrl
    webviewRef.current.src = finalUrl
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      navigate(inputUrl)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', background: '#1e1e1e' }}>
      <div className="browser-toolbar">
        <button
          className="browser-nav-btn"
          disabled={!canGoBack}
          onClick={() => webviewRef.current?.goBack()}
        >←</button>
        <button
          className="browser-nav-btn"
          disabled={!canGoForward}
          onClick={() => webviewRef.current?.goForward()}
        >→</button>
        <button
          className="browser-nav-btn"
          onClick={() => webviewRef.current?.reload()}
        >{loading ? '✕' : '↻'}</button>
        <input
          className="browser-url-input"
          value={inputUrl}
          onChange={(e) => setInputUrl(e.target.value)}
          onKeyDown={handleKeyDown}
          spellCheck={false}
        />
      </div>
      <div ref={containerRef} style={{ flex: 1, overflow: 'hidden' }} />
    </div>
  )
}
