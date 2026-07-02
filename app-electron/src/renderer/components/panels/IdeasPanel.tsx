import { IDockviewPanelProps } from 'dockview'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useIpcQuery } from '../../hooks/useIpcQuery'
import { getWindowId } from '../../utils/window-params'
import { makeDataSource } from '../../datasource/panelDataSource'
import type { RemotePeer } from '../../../../../core/types/remote-control'
import type { Idea } from '../../../../../core/types/ideas'

type SortMode = 'default' | 'manual' | 'createdDesc' | 'dueAsc' | 'titleAlpha'

const IMPORTANCE_LABEL: Record<1 | 2 | 3 | 4 | 5, string> = {
  1: 'low', 2: 'low+', 3: 'normal', 4: 'high', 5: 'critical',
}

function makeIdea(): Idea {
  const now = new Date().toISOString()
  return {
    id: crypto.randomUUID(),
    title: '',
    body: '',
    category: '',
    importance: 3,
    dueDate: '',
    createdAt: now,
    updatedAt: now,
  }
}

function compareIdeas(a: Idea, b: Idea, mode: SortMode): number {
  if (mode === 'manual') return 0   // preserve array order
  if (mode === 'createdDesc') return b.createdAt.localeCompare(a.createdAt)
  if (mode === 'titleAlpha') return a.title.localeCompare(b.title)
  if (mode === 'dueAsc') {
    const av = a.dueDate || '￿'  // empty dates sort last
    const bv = b.dueDate || '￿'
    return av.localeCompare(bv)
  }
  // default: importance desc, then dueDate asc (no-date last), then createdAt desc
  if (a.importance !== b.importance) return b.importance - a.importance
  const av = a.dueDate || '￿'
  const bv = b.dueDate || '￿'
  if (av !== bv) return av.localeCompare(bv)
  return b.createdAt.localeCompare(a.createdAt)
}

interface IdeasParams {
  /** When set, ideas load/save go to this PEER over the op API (Direction #2). */
  peer?: RemotePeer
  /** The peer's windowId whose ideas to show (ideas are per-window). Required in remote mode. */
  windowId?: string
}

export function IdeasPanel({ params }: IDockviewPanelProps<IdeasParams>) {
  const ds = useMemo(() => makeDataSource(params?.peer), [params?.peer?.id])
  // Local: this window's id. Remote: the addressed peer window's id (ideas are window-scoped).
  const windowId = params?.peer ? (params.windowId ?? '0') : getWindowId()
  const [ideas, setIdeas] = useState<Idea[]>([])
  const [filterCategory, setFilterCategory] = useState<string>('')
  const [filterImportance, setFilterImportance] = useState<number>(0)
  const [filterText, setFilterText] = useState<string>('')
  const [sortMode, setSortMode] = useState<SortMode>(() => {
    return (localStorage.getItem('ideas-sort-mode') as SortMode | null) ?? 'default'
  })
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  const [dropBefore, setDropBefore] = useState<boolean>(true)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const focusIdRef = useRef<string | null>(null)
  const titleRefs = useRef<Map<string, HTMLInputElement>>(new Map())

  // Load on mount.
  const initialLoad = useIpcQuery<Idea[]>(
    () => ds.loadIdeas(windowId),
    [windowId, ds],
    {
      onResolve: (data) => {
        setIdeas(data)
      },
    },
  )

  // Debounced save 500ms after the last mutation.
  const scheduleSave = (next: Idea[]) => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      void ds.saveIdeas(windowId, next)
    }, 500)
  }

  useEffect(() => {
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current) }
  }, [])

  // Persist sort selection in localStorage (UI state, not part of file).
  useEffect(() => {
    localStorage.setItem('ideas-sort-mode', sortMode)
  }, [sortMode])

  const update = (id: string, patch: Partial<Idea>) => {
    const next = ideas.map((i) =>
      i.id === id ? { ...i, ...patch, updatedAt: new Date().toISOString() } : i,
    )
    setIdeas(next)
    scheduleSave(next)
  }

  const add = () => {
    const fresh = makeIdea()
    const next = [fresh, ...ideas]
    setIdeas(next)
    focusIdRef.current = fresh.id
    scheduleSave(next)
  }

  const remove = (id: string) => {
    if (!confirm('Delete this idea?')) return
    const next = ideas.filter((i) => i.id !== id)
    setIdeas(next)
    scheduleSave(next)
  }

  // Reorder the underlying ideas array. Auto-switches sort mode to
  // 'manual' so the new order survives — other sort modes would
  // immediately reshuffle the dragged item back to its computed slot.
  const reorder = (fromId: string, toId: string, before: boolean) => {
    if (fromId === toId) return
    const fromIdx = ideas.findIndex((i) => i.id === fromId)
    if (fromIdx < 0) return
    const moved = ideas[fromIdx]
    const withoutMoved = ideas.filter((i) => i.id !== fromId)
    const toIdx = withoutMoved.findIndex((i) => i.id === toId)
    if (toIdx < 0) return
    const insertAt = before ? toIdx : toIdx + 1
    const next = [
      ...withoutMoved.slice(0, insertAt),
      moved,
      ...withoutMoved.slice(insertAt),
    ]
    setIdeas(next)
    if (sortMode !== 'manual') setSortMode('manual')
    scheduleSave(next)
  }

  // Focus title input after a new idea is added (after DOM render).
  useEffect(() => {
    if (focusIdRef.current) {
      const el = titleRefs.current.get(focusIdRef.current)
      el?.focus()
      focusIdRef.current = null
    }
  }, [ideas])

  // Derived category list — autocomplete suggestions.
  const categoryOptions = useMemo(
    () => Array.from(new Set(ideas.map((i) => i.category).filter(Boolean))).sort(),
    [ideas],
  )

  // Apply filters + sort.
  const visible = useMemo(() => {
    const lowSearch = filterText.toLowerCase().trim()
    return ideas
      .filter((i) => !filterCategory || i.category === filterCategory)
      .filter((i) => !filterImportance || i.importance >= filterImportance)
      .filter((i) => !lowSearch
        || i.title.toLowerCase().includes(lowSearch)
        || i.body.toLowerCase().includes(lowSearch))
      .sort((a, b) => compareIdeas(a, b, sortMode))
  }, [ideas, filterCategory, filterImportance, filterText, sortMode])

  return (
    <div className="ideas-panel">
      <div className="ideas-toolbar">
        <button className="notes-btn notes-btn-primary" onClick={add}>+ Add idea</button>
        <input
          type="text"
          className="ideas-filter-input"
          placeholder="Search title / body…"
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          spellCheck={false}
        />
        <select
          className="ideas-filter-select"
          value={filterCategory}
          onChange={(e) => setFilterCategory(e.target.value)}
        >
          <option value="">All categories</option>
          {categoryOptions.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select
          className="ideas-filter-select"
          value={filterImportance}
          onChange={(e) => setFilterImportance(Number(e.target.value))}
        >
          <option value={0}>Any importance</option>
          <option value={2}>≥ low+</option>
          <option value={3}>≥ normal</option>
          <option value={4}>≥ high</option>
          <option value={5}>only critical</option>
        </select>
        <select
          className="ideas-filter-select"
          value={sortMode}
          onChange={(e) => setSortMode(e.target.value as SortMode)}
        >
          <option value="default">Sort: smart</option>
          <option value="manual">Sort: manual (drag)</option>
          <option value="createdDesc">Sort: newest</option>
          <option value="dueAsc">Sort: due date</option>
          <option value="titleAlpha">Sort: A→Z</option>
        </select>
      </div>

      {initialLoad.loading && ideas.length === 0 && (
        <div className="ideas-empty">Loading…</div>
      )}
      {!initialLoad.loading && visible.length === 0 && (
        <div className="ideas-empty">
          {ideas.length === 0 ? 'No ideas yet — click "+ Add idea" to start.' : 'No ideas match the current filters.'}
        </div>
      )}

      <div className="ideas-list">
        {visible.map((idea) => {
          const dropClass = dropTargetId === idea.id
            ? (dropBefore ? ' ideas-drop-before' : ' ideas-drop-after')
            : ''
          const dragClass = dragId === idea.id ? ' ideas-dragging' : ''
          return (
          <div
            key={idea.id}
            className={`ideas-card ideas-importance-${idea.importance}${dragClass}${dropClass}`}
            onDragOver={(e) => {
              if (!dragId || dragId === idea.id) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              const rect = e.currentTarget.getBoundingClientRect()
              const before = e.clientY < rect.top + rect.height / 2
              setDropTargetId(idea.id)
              setDropBefore(before)
            }}
            onDragLeave={(e) => {
              // Only clear if leaving the card entirely (not entering a child).
              if (e.currentTarget.contains(e.relatedTarget as Node)) return
              if (dropTargetId === idea.id) setDropTargetId(null)
            }}
            onDrop={(e) => {
              if (!dragId || dragId === idea.id) return
              e.preventDefault()
              reorder(dragId, idea.id, dropBefore)
              setDragId(null)
              setDropTargetId(null)
            }}
          >
            <div
              className="ideas-card-handle"
              draggable
              onDragStart={(e) => {
                setDragId(idea.id)
                e.dataTransfer.effectAllowed = 'move'
                // Use the card itself as drag image for visual feedback.
                const card = (e.currentTarget as HTMLElement).parentElement
                if (card) e.dataTransfer.setDragImage(card, 20, 20)
              }}
              onDragEnd={() => {
                setDragId(null)
                setDropTargetId(null)
              }}
              title="Drag to reorder"
            />
            <div className="ideas-card-body">
            <div className="ideas-card-row">
              <input
                ref={(el) => {
                  if (el) titleRefs.current.set(idea.id, el)
                  else titleRefs.current.delete(idea.id)
                }}
                type="text"
                className="ideas-title-input"
                value={idea.title}
                onChange={(e) => update(idea.id, { title: e.target.value })}
                placeholder="Idea title…"
                spellCheck={false}
              />
              <button
                className="ideas-delete-btn"
                onClick={() => remove(idea.id)}
                title="Delete idea"
              >×</button>
            </div>
            <div className="ideas-card-row ideas-meta-row">
              <input
                type="text"
                className="ideas-category-input"
                value={idea.category}
                onChange={(e) => update(idea.id, { category: e.target.value })}
                placeholder="category…"
                list={`ideas-cat-${idea.id}`}
                spellCheck={false}
              />
              <datalist id={`ideas-cat-${idea.id}`}>
                {categoryOptions.map((c) => <option key={c} value={c} />)}
              </datalist>
              <div className="ideas-importance-picker" title={`Importance: ${IMPORTANCE_LABEL[idea.importance]}`}>
                {[1, 2, 3, 4, 5].map((lvl) => (
                  <button
                    key={lvl}
                    className={`ideas-imp-btn ${idea.importance >= lvl ? 'active' : ''}`}
                    onClick={() => update(idea.id, { importance: lvl as 1 | 2 | 3 | 4 | 5 })}
                  >★</button>
                ))}
              </div>
              <input
                type="date"
                className="ideas-due-input"
                value={idea.dueDate}
                onChange={(e) => update(idea.id, { dueDate: e.target.value })}
                title="Due date (optional)"
              />
              {idea.dueDate && (
                <button
                  className="ideas-due-clear"
                  onClick={() => update(idea.id, { dueDate: '' })}
                  title="Clear due date"
                >×</button>
              )}
            </div>
            <textarea
              className="ideas-body-textarea"
              value={idea.body}
              onChange={(e) => update(idea.id, { body: e.target.value })}
              placeholder="Notes / details…"
              rows={2}
              spellCheck={false}
            />
            </div>
          </div>
          )
        })}
      </div>
    </div>
  )
}
