import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useIpcQuery } from '../../hooks/useIpcQuery'
import { makeDataSource } from '../../datasource/panelDataSource'
import type { RemotePeer } from '../../../../../core/types/remote-control'

interface NotesPanelProps {
  panelId: string
  visible: boolean
  /** Paste a note into the owning terminal. Local panels pass this; a peer-backed standalone
   *  notes view omits it (there's no local terminal to paste into) — the Paste control is hidden. */
  onPaste?: (text: string) => void
  /** When set (Claude terminals), shows "Import from prompt": pulls the unsent prompt text into
   *  a note and clears it. Returns the imported text, or null when there was nothing to import. */
  onImportFromPrompt?: () => Promise<string | null>
  /** When set, notes load/save go to this PEER over the op API instead of the local store (Direction #2). */
  peer?: RemotePeer
}

export function NotesPanel({ panelId, visible, onPaste, onImportFromPrompt, peer }: NotesPanelProps) {
  const ds = useMemo(() => makeDataSource(peer), [peer?.id])
  const [entries, setEntries] = useState<string[]>([''])
  const [sticky, setSticky] = useState<boolean[]>([false])
  const [large, setLarge] = useState<boolean[]>([false])
  const [focusIndex, setFocusIndex] = useState<number | null>(null)
  const saveTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  const textareaRefs = useRef<Map<number, HTMLTextAreaElement>>(new Map())

  useEffect(() => {
    return () => { if (saveTimeout.current) clearTimeout(saveTimeout.current) }
  }, [])

  // Reset transient state when the active panel switches — otherwise a
  // typing user briefly sees the previous panel's entries during the
  // in-flight load and the debounced save would write old entries under
  // the new panelId.
  useEffect(() => {
    setEntries([''])
    setSticky([false])
    setLarge([false])
    if (saveTimeout.current) {
      clearTimeout(saveTimeout.current)
      saveTimeout.current = null
    }
  }, [panelId])

  const notesQuery = useIpcQuery<string[]>(
    () => ds.loadNotes(panelId),
    [panelId, ds],
    {
      onResolve: (data) => {
        if (data && data.length > 0) {
          setEntries(data)
          setSticky(new Array(data.length).fill(false))
          setLarge(new Array(data.length).fill(false))
        }
      },
    },
  )
  // Panel is "loaded" once the load has either resolved or errored AND no new load is in flight.
  const loaded = !notesQuery.loading && (notesQuery.data !== null || notesQuery.error !== null)

  const save = (newEntries: string[]) => {
    if (saveTimeout.current) clearTimeout(saveTimeout.current)
    saveTimeout.current = setTimeout(() => {
      void ds.saveNotes(panelId, newEntries)
    }, 500)
  }

  const updateEntry = (index: number, value: string) => {
    const next = [...entries]
    next[index] = value
    setEntries(next)
    save(next)
  }

  const addEntry = () => {
    const next = [...entries, '']
    setEntries(next)
    setSticky([...sticky, false])
    setLarge([...large, false])
    setFocusIndex(next.length - 1)
    save(next)
  }

  // Focus the requested textarea after it's been mounted (useLayoutEffect
  // runs after DOM is updated but before paint, so no flicker).
  useLayoutEffect(() => {
    if (focusIndex === null) return
    const el = textareaRefs.current.get(focusIndex)
    if (el) {
      el.focus()
      setFocusIndex(null)
    }
  }, [focusIndex, entries])

  const removeEntry = (index: number) => {
    if (entries.length <= 1) return
    const next = entries.filter((_, i) => i !== index)
    setEntries(next)
    setSticky(sticky.filter((_, i) => i !== index))
    setLarge(large.filter((_, i) => i !== index))
    save(next)
  }

  const toggleSticky = (index: number) => {
    const next = [...sticky]
    next[index] = !next[index]
    setSticky(next)
  }

  const toggleLarge = (index: number) => {
    const next = [...large]
    next[index] = !next[index]
    setLarge(next)
  }

  const [importing, setImporting] = useState(false)
  const [importMsg, setImportMsg] = useState<string | null>(null)
  const importFromPrompt = async () => {
    if (!onImportFromPrompt || importing) return
    setImporting(true)
    setImportMsg(null)
    try {
      const text = (await onImportFromPrompt())?.trim()
      if (!text) { setImportMsg('Nothing in the prompt to import'); setTimeout(() => setImportMsg(null), 2500); return }
      // Drop it into the single empty note if that's all there is, else append a new one.
      if (entries.length === 1 && entries[0].trim() === '') {
        setEntries([text]); setSticky([false]); setLarge([false]); save([text]); setFocusIndex(0)
      } else {
        const next = [...entries, text]
        setEntries(next); setSticky([...sticky, false]); setLarge([...large, false]); save(next); setFocusIndex(next.length - 1)
      }
    } catch (e) {
      setImportMsg(`Import failed: ${e instanceof Error ? e.message : String(e)}`)
      setTimeout(() => setImportMsg(null), 4000)
    } finally {
      setImporting(false)
    }
  }

  const pasteEntry = (index: number) => {
    const text = entries[index].trim()
    if (!text || !onPaste) return
    onPaste(text)
    if (sticky[index]) return
    if (entries.length > 1) {
      removeEntry(index)
    } else {
      updateEntry(0, '')
    }
  }

  if (!visible || !loaded) return null

  return (
    <div className="notes-panel">
      <div className="notes-entries">
        {entries.map((text, i) => (
          <div key={i} className="notes-entry">
            <div className="notes-entry-toolbar">
              <span className="notes-entry-label">#{i + 1}</span>
              {/* Paste + sticky are terminal affordances — hidden for a peer-backed standalone notes view. */}
              {onPaste && (
                <>
                  <button
                    className="notes-btn notes-paste-btn"
                    onClick={() => pasteEntry(i)}
                    title={sticky[i] ? 'Paste to terminal (keep note)' : 'Paste to terminal and clear'}
                  >
                    Paste
                  </button>
                  <button
                    className={`notes-btn notes-sticky-btn ${sticky[i] ? 'active' : ''}`}
                    onClick={() => toggleSticky(i)}
                    title={sticky[i] ? 'Sticky: keep after paste' : 'Not sticky: clear after paste'}
                  >
                    📌
                  </button>
                </>
              )}
              <button
                className={`notes-btn notes-large-btn ${large[i] ? 'active' : ''}`}
                onClick={() => toggleLarge(i)}
                title={large[i] ? 'Compact editor' : 'Large editor (4× taller)'}
              >
                ↕
              </button>
              <button
                className="notes-btn"
                onClick={() => entries.length > 1 ? removeEntry(i) : updateEntry(i, '')}
                title={entries.length > 1 ? 'Remove entry' : 'Clear note'}
              >
                ×
              </button>
            </div>
            <textarea
              ref={(el) => {
                if (el) textareaRefs.current.set(i, el)
                else textareaRefs.current.delete(i)
              }}
              className={`notes-textarea ${large[i] ? 'large' : ''}`}
              value={text}
              onChange={(e) => updateEntry(i, e.target.value)}
              placeholder="Write notes here..."
              spellCheck={false}
            />
          </div>
        ))}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '4px 0' }}>
          <button className="notes-btn" onClick={addEntry}>+ Add note</button>
          {onImportFromPrompt && (
            <button
              className="notes-btn"
              onClick={importFromPrompt}
              disabled={importing}
              title="Pull the text you've typed (but not sent) in the Claude prompt into a note, and clear the prompt"
            >
              {importing ? 'Importing…' : '⬆ Import from prompt'}
            </button>
          )}
          {importMsg && <span style={{ fontSize: 11, color: '#d29922', alignSelf: 'center' }}>{importMsg}</span>}
        </div>
      </div>
    </div>
  )
}
