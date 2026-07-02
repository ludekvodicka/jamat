import { useEffect, useState } from 'react'
import { loadSettings } from './panels/SettingsPanel'

interface ToastMessage {
  id: number
  text: string
  title: string
}

let toastId = 0
const listeners: Set<(msg: ToastMessage) => void> = new Set()

export function showToast(title: string, text: string) {
  const msg = { id: ++toastId, title, text }
  listeners.forEach(fn => fn(msg))
}

export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastMessage[]>([])

  useEffect(() => {
    const handler = (msg: ToastMessage) => {
      setToasts(prev => [...prev, msg])
      const duration = loadSettings().toastDurationSeconds * 1000
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== msg.id))
      }, duration)
    }
    listeners.add(handler)
    return () => { listeners.delete(handler) }
  }, [])

  if (toasts.length === 0) return null

  return (
    <div className="toast-container">
      {toasts.map(t => (
        <div key={t.id} className="toast" onClick={() => setToasts(prev => prev.filter(x => x.id !== t.id))}>
          <div className="toast-title">{t.title}</div>
          <div className="toast-text">{t.text}</div>
        </div>
      ))}
    </div>
  )
}
