import { useEffect, useState } from 'react'
import { useLayoutStore } from '../store/layout-store'
import { copyText } from '../utils/clipboard'

/**
 * Status-bar clipboard diagnostic. OFF by default — toggle it under Settings → Debug
 * ("Show clipboard debug in status bar"). Shows the live clipboard pipeline so clipboard issues can
 * be diagnosed by sight instead of guesswork (kept around because new terminal backends — e.g. a
 * ChatGPT agent — will likely have their own copy quirks):
 *  - `clip:"…"(n)`  — the REAL OS clipboard, polled silently every 0.5s (debugReadClipboard).
 *  - `osc52:"…"×k`  — the last OSC 52 copy emitted by the terminal app (Claude) + a count. This is
 *                     the actual "what got copied" while the app has mouse tracking on (xterm makes no
 *                     local selection then, so `sel:` stays empty — see useTerminal's OSC 52 handler).
 *  - `sel:"…"`      — xterm's own selection (only set for shells / Shift-drag, not Claude mouse mode).
 *  - `foc`          — document.hasFocus(); the navigator.clipboard path is gated on this.
 *  - Copy IPC       — copy the current selection through the main-process clipboard, then verify.
 *  - Copy nav       — copy via navigator.clipboard (the focus-gated path) to compare.
 */

const short = (s: string, n = 22): string => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n) + '…' : one
}

export function ClipboardDebug() {
  const selection = useLayoutStore(s => s.terminalSelection)
  const [clip, setClip] = useState('')
  const [focus, setFocus] = useState(true)
  const [osc, setOsc] = useState<{ text: string; n: number }>({ text: '', n: 0 })
  const [note, setNote] = useState('')

  useEffect(() => {
    let stop = false
    const tick = async () => {
      try {
        const t = await window.electronAPI?.debugReadClipboard?.()
        if (!stop && typeof t === 'string') setClip(t)
      } catch { /* ignore */ }
      if (!stop) setFocus(document.hasFocus())
    }
    void tick()
    const id = setInterval(tick, 500)
    return () => { stop = true; clearInterval(id) }
  }, [])

  useEffect(() => {
    const onOsc = (e: Event) => {
      const text = (e as CustomEvent).detail?.text as string ?? ''
      setOsc((prev) => ({ text, n: prev.n + 1 }))
    }
    window.addEventListener('clipboard-osc52', onOsc)
    return () => window.removeEventListener('clipboard-osc52', onOsc)
  }, [])

  const flash = (m: string) => { setNote(m); setTimeout(() => setNote(''), 3000) }

  const copyIpc = async () => {
    const sel = selection || ''
    await copyText(sel)
    const back = (await window.electronAPI?.debugReadClipboard?.()) ?? ''
    flash(back === sel ? `IPC ✓ (${sel.length})` : `IPC ✗ clip≠sel`)
  }

  const copyNav = async () => {
    const sel = selection || ''
    try {
      await navigator.clipboard.writeText(sel)
      flash(`nav ✓ foc=${document.hasFocus() ? '1' : '0'}`)
    } catch (e) {
      flash(`nav ✗ ${(e as Error)?.name ?? 'err'} foc=${document.hasFocus() ? '1' : '0'}`)
    }
  }

  return (
    <span
      className="status-item"
      style={{ fontFamily: 'monospace', fontSize: '11px', display: 'inline-flex', gap: 6, alignItems: 'center', opacity: 0.95 }}
    >
      <span title="Live OS clipboard (polled 0.5s)">🐛 clip:{clip ? `"${short(clip)}"(${clip.length})` : '∅'}</span>
      <span style={{ color: osc.n ? '#7ad' : undefined }} title="Last OSC 52 copy emitted by the terminal app (Claude)">
        osc52:{osc.n ? `"${short(osc.text)}"×${osc.n}` : '∅'}
      </span>
      <span title="xterm's own selection (shells / Shift-drag only)">sel:{selection ? `"${short(selection, 12)}"` : '∅'}</span>
      <span style={{ color: focus ? '#4ec94e' : '#e0707a' }} title="document.hasFocus()">foc:{focus ? '✓' : '✗'}</span>
      <button className="status-btn" onClick={copyIpc} title="Copy current xterm selection via the main-process clipboard (IPC), then verify">Copy IPC</button>
      <button className="status-btn" onClick={copyNav} title="Copy current xterm selection via navigator.clipboard (the focus-gated path) — for comparison">Copy nav</button>
      {note && <span style={{ color: '#ffd866' }}>{note}</span>}
    </span>
  )
}
