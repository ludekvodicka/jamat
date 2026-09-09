import type { IDockviewPanelProps } from 'dockview'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import type {
  FileViewerDocumentSource,
  FileViewerLocation,
} from '../../../../lib-orchestrator/fileViewer/fileViewerApi.types'
import { FileViewerSourceShape } from '../../fileViewer/fileViewerSourceShape'
import type { FileViewerBaselineHint } from '../../fileViewer/fileViewerPanel.types'
import { FileViewerZoom } from '../../fileViewer/fileViewerZoom'
import { ContextMenu, type ContextMenuPosition } from '../contextMenu'
import { usePanelParameters } from './panelParameters'
import './panelSplit.css'

/** One inner tab. Its identity is the document key, which is what makes opening the same file twice
 *  an activation rather than a second tab. `source` is the only durable half: grant ids never
 *  reach a layout, so a restored item asks for its grant again. */
export interface PanelSplitItem {
  key: string
  title: string
  source: FileViewerDocumentSource
  baselineHint?: FileViewerBaselineHint
  location?: FileViewerLocation
  /** Reading size for this file alone; absent is the configured size, which is what 100 % means. */
  zoomPercent?: number
}

export interface PanelSplitState {
  ratio: number
  active: string | null
  preview: string | null
  /** Empty means the split is not there at all: visibility is derived, never stored. */
  items: readonly PanelSplitItem[]
  history: readonly PanelSplitItem[]
}

export interface PanelSplitCapture {
  item: PanelSplitItem
  incarnation: number
}

export interface PanelSplitHandle {
  state: PanelSplitState
  /** `null` when the item was taken; a sentence when it was refused, for the caller to show. */
  open(item: PanelSplitItem): string | null
  back(): string | null
  activate(key: string): void
  keepOpen(key: string): void
  close(key: string): void
  capture(key: string): PanelSplitCapture | null
  closeCaptured(capture: PanelSplitCapture): boolean
  resize(ratio: number): void
}

/**
 * What a tab's split remembers, and where. Same store as the tab sidebar beside it: the panel's own
 * parameters, which dockview serializes into the layout. TabsController also carries them across a
 * user close and reopen for this window's lifetime, one copy per panel after a split of the tab
 * itself.
 *
 * The transitions are static and pure because two callers share them: the hook here, and the
 * `open-file` arm in `WorkspacePanels`, which writes the same state from outside the React tree.
 * One copy of the cap and the dedupe, so an agent cannot open a ninth file the person cannot.
 */
export class PanelSplitParams {
  private static readonly paramsKeyConst = 'split'
  static readonly itemsMaxConst = 8
  static readonly historyMaxConst = 50
  private static readonly ratioDefaultConst = 0.5
  private static readonly ratioMinConst = 0.15
  private static readonly ratioMaxConst = 0.85
  /** Three places is finer than a person can aim and coarse enough that a drag writes one layout. */
  private static readonly ratioDigitsConst = 3

  static default(): PanelSplitState {
    return { ratio: PanelSplitParams.ratioDefaultConst, active: null, preview: null, items: [], history: [] }
  }

  static of(params: unknown): PanelSplitState {
    const stored = PanelSplitParams.stored(params)
    if (stored === null)
      return PanelSplitParams.default()
    const items = PanelSplitParams.items(stored.items)
    return {
      ratio: typeof stored.ratio === 'number'
        ? PanelSplitParams.clampRatio(stored.ratio)
        : PanelSplitParams.ratioDefaultConst,
      items,
      active: PanelSplitParams.active(stored.active, items),
      preview: PanelSplitParams.preview(stored.preview, items),
      history: items.length === 0 ? [] : PanelSplitParams.history(stored.history),
    }
  }

  static merged(params: unknown, state: PanelSplitState): Record<string, unknown> {
    const current = params && typeof params === 'object' ? params as Record<string, unknown> : {}
    return { ...current, [PanelSplitParams.paramsKeyConst]: state }
  }

  static clampRatio(ratio: number): number {
    if (!Number.isFinite(ratio))
      return PanelSplitParams.ratioDefaultConst
    const bounded = Math.min(
      PanelSplitParams.ratioMaxConst,
      Math.max(PanelSplitParams.ratioMinConst, ratio),
    )
    const scale = 10 ** PanelSplitParams.ratioDigitsConst
    return Math.round(bounded * scale) / scale
  }

  static opened(state: PanelSplitState, item: PanelSplitItem):
    | { ok: true; state: PanelSplitState }
    | { ok: false; refusal: string } {
    const result = PanelSplitParams.placed(state, item)
    if (!result.ok)
      return result
    return {
      ok: true,
      state: { ...result.state, history: PanelSplitParams.remembered(state, item.key) },
    }
  }

  static backTargetOf(state: PanelSplitState): PanelSplitItem | null {
    if (state.active === null)
      return null
    return state.history.findLast((item) => item.key !== state.active) ?? null
  }

  static navigatedBack(state: PanelSplitState): ReturnType<typeof PanelSplitParams.opened> {
    const target = PanelSplitParams.backTargetOf(state)
    if (target === null)
      return { ok: true, state }
    const result = PanelSplitParams.placed(state, target)
    if (!result.ok)
      return result
    return {
      ok: true,
      state: { ...result.state, history: state.history.slice(0, state.history.lastIndexOf(target)) },
    }
  }

  private static remembered(state: PanelSplitState, nextKey: string): readonly PanelSplitItem[] {
    const previous = state.items.find((item) => item.key === state.active)
    if (previous === undefined || previous.key === nextKey)
      return state.history
    return [...state.history, previous].slice(-PanelSplitParams.historyMaxConst)
  }

  private static placed(
    state: PanelSplitState,
    item: PanelSplitItem,
  ): ReturnType<typeof PanelSplitParams.opened> {
    const existing = state.items.findIndex((candidate) => candidate.key === item.key)
    if (existing !== -1) {
      // The same file again is the same tab, brought forward. The item is replaced rather than
      // kept, because the second open may carry a baseline the first one did not.
      const items = state.items.map((candidate, index) => index === existing ? item : candidate)
      return { ok: true, state: { ...state, items, active: item.key } }
    }
    const previewIndex = state.preview === null
      ? -1
      : state.items.findIndex((candidate) => candidate.key === state.preview)
    if (previewIndex !== -1) {
      const items = state.items.map((candidate, index) => index === previewIndex ? item : candidate)
      return {
        ok: true,
        state: { ...state, items, active: item.key, preview: item.key },
      }
    }
    if (state.items.length >= PanelSplitParams.itemsMaxConst)
      return {
        ok: false,
        refusal: `The split already holds ${PanelSplitParams.itemsMaxConst} files.`
          + ' Close one before opening another.',
      }
    return {
      ok: true,
      state: { ...state, items: [...state.items, item], active: item.key, preview: item.key },
    }
  }

  static closed(state: PanelSplitState, key: string): PanelSplitState {
    const index = state.items.findIndex((candidate) => candidate.key === key)
    if (index === -1)
      return state
    const items = state.items.filter((candidate) => candidate.key !== key)
    const preview = state.preview === key ? null : state.preview
    const history = items.length === 0 ? [] : state.history.filter((item) => item.key !== key)
    if (state.active !== key)
      return { ...state, items, preview, history }
    // The next sibling takes over, and the previous one when there is no next: the rule the real
    // tabs use when the panel in front of somebody goes away. `ratio` survives an empty list, so
    // the width a person dragged is still theirs the next time something opens.
    const next = items[index] ?? items[index - 1] ?? null
    return { ...state, items, active: next === null ? null : next.key, preview, history }
  }

  static activated(state: PanelSplitState, key: string): PanelSplitState {
    if (!state.items.some((candidate) => candidate.key === key))
      return state
    return { ...state, active: key, history: PanelSplitParams.remembered(state, key) }
  }

  static keptOpen(state: PanelSplitState, key: string): PanelSplitState {
    if (state.preview !== key)
      return state
    return { ...state, preview: null }
  }

  private static stored(params: unknown): Partial<PanelSplitState> | null {
    if (!params || typeof params !== 'object')
      return null
    const stored = (params as Record<string, unknown>)[PanelSplitParams.paramsKeyConst]
    if (!stored || typeof stored !== 'object')
      return null
    return stored as Partial<PanelSplitState>
  }

  /** Field by field, and an unreadable entry is dropped rather than taking the rest with it. */
  private static items(value: unknown): readonly PanelSplitItem[] {
    if (!Array.isArray(value))
      return []
    const items: PanelSplitItem[] = []
    for (const entry of value) {
      if (items.length >= PanelSplitParams.itemsMaxConst)
        break
      const item = PanelSplitParams.item(entry)
      if (item === null)
        continue
      if (items.some((held) => held.key === item.key))
        continue
      items.push(item)
    }
    return items
  }

  private static history(value: unknown): readonly PanelSplitItem[] {
    if (!Array.isArray(value))
      return []
    return value.slice(-PanelSplitParams.historyMaxConst).flatMap((entry) => {
      const item = PanelSplitParams.item(entry)
      return item === null ? [] : [item]
    })
  }

  private static item(value: unknown): PanelSplitItem | null {
    if (!value || typeof value !== 'object')
      return null
    const candidate = value as Partial<PanelSplitItem>
    const source = FileViewerSourceShape.read(candidate.source)
    if (source === null
      || typeof candidate.key !== 'string' || !candidate.key
      || typeof candidate.title !== 'string' || !candidate.title)
      return null
    const location = FileViewerSourceShape.location(candidate.location)
    const zoomPercent = typeof candidate.zoomPercent === 'number'
      && Number.isFinite(candidate.zoomPercent)
      ? FileViewerZoom.snap(candidate.zoomPercent)
      : undefined
    return {
      key: candidate.key,
      title: candidate.title,
      source,
      baselineHint: FileViewerSourceShape.hint(candidate.baselineHint),
      ...(location === undefined ? {} : { location }),
      ...(zoomPercent === undefined ? {} : { zoomPercent }),
    }
  }

  private static active(value: unknown, items: readonly PanelSplitItem[]): string | null {
    if (items.length === 0)
      return null
    if (typeof value === 'string' && items.some((item) => item.key === value))
      return value
    return items[0].key
  }

  private static preview(value: unknown, items: readonly PanelSplitItem[]): string | null {
    if (typeof value === 'string' && items.some((item) => item.key === value))
      return value
    return null
  }
}

export function usePanelSplit(props: IDockviewPanelProps): PanelSplitHandle {
  const [state, setState] = useState<PanelSplitState>(() => PanelSplitParams.of(props.params))
  const { current: currentParameters, update: updateParameters } = usePanelParameters(props)
  const [incarnations] = useState(() => new PanelSplitIncarnations(
    PanelSplitParams.of(props.params),
  ))
  const api = props.api
  const params = props.params
  /** What this hook last wrote, so a parameter change from anywhere else is recognisable. */
  const written = useRef<string | null>(null)

  useLayoutEffect(() => {
    const disposable = api.onDidParametersChange(() => {
      incarnations.synchronize(PanelSplitParams.of(currentParameters()))
    })
    return () => disposable.dispose()
  }, [api, currentParameters, incarnations])

  useLayoutEffect(() => {
    incarnations.synchronize(PanelSplitParams.of(currentParameters()))
  }, [currentParameters, incarnations, params])

  // Two things arrive this way and neither is this hook: dockview's fromJSON, which REUSES a live
  // panel with the same id, and the `open-file` control arm, which writes an item into the panel's
  // parameters from outside React. Without the latch the hook's own next write would put its stale
  // copy back over either of them.
  const incoming = JSON.stringify(PanelSplitParams.of(params))
  useEffect(() => {
    if (incoming === written.current)
      return
    written.current = incoming
    setState(JSON.parse(incoming) as PanelSplitState)
  }, [incoming])

  const store = useCallback((currentParams: unknown, next: PanelSplitState) => {
    written.current = JSON.stringify(next)
    setState(next)
    // `api.updateParameters` and not `panel.update`, for the reason the sidebar carries: only this
    // path reaches the group model, and only that makes dockview fire onDidLayoutChange, which is
    // what the debounced layout save listens to.
    updateParameters(PanelSplitParams.merged(currentParams, next))
  }, [updateParameters])

  return {
    state,
    open: useCallback((item: PanelSplitItem): string | null => {
      const currentParams = currentParameters()
      const result = PanelSplitParams.opened(PanelSplitParams.of(currentParams), item)
      if (!result.ok)
        return result.refusal
      store(currentParams, result.state)
      return null
    }, [currentParameters, store]),
    back: useCallback((): string | null => {
      const currentParams = currentParameters()
      const current = PanelSplitParams.of(currentParams)
      const result = PanelSplitParams.navigatedBack(current)
      if (!result.ok)
        return result.refusal
      if (result.state !== current)
        store(currentParams, result.state)
      return null
    }, [currentParameters, store]),
    activate: useCallback(
      (key: string) => {
        const currentParams = currentParameters()
        store(currentParams, PanelSplitParams.activated(PanelSplitParams.of(currentParams), key))
      },
      [currentParameters, store],
    ),
    keepOpen: useCallback(
      (key: string) => {
        const currentParams = currentParameters()
        const current = PanelSplitParams.of(currentParams)
        const next = PanelSplitParams.keptOpen(current, key)
        if (next === current)
          return
        store(currentParams, next)
      },
      [currentParameters, store],
    ),
    close: useCallback(
      (key: string) => {
        const currentParams = currentParameters()
        store(currentParams, PanelSplitParams.closed(PanelSplitParams.of(currentParams), key))
      },
      [currentParameters, store],
    ),
    capture: useCallback((key: string): PanelSplitCapture | null => {
      const current = PanelSplitParams.of(currentParameters())
      return incarnations.capture(current, key)
    }, [currentParameters, incarnations]),
    closeCaptured: useCallback((capture: PanelSplitCapture): boolean => {
      const currentParams = currentParameters()
      const current = PanelSplitParams.of(currentParams)
      if (!incarnations.matches(current, capture))
        return false
      store(currentParams, PanelSplitParams.closed(current, capture.item.key))
      return true
    }, [currentParameters, incarnations, store]),
    resize: useCallback(
      (ratio: number) => {
        const currentParams = currentParameters()
        const current = PanelSplitParams.of(currentParams)
        store(currentParams, { ...current, ratio: PanelSplitParams.clampRatio(ratio) })
      },
      [currentParameters, store],
    ),
  }
}

class PanelSplitIncarnations {
  private readonly versions = new Map<string, number>()
  private identities = new Map<string, string>()

  constructor(state: PanelSplitState) {
    this.synchronize(state)
  }

  synchronize(state: PanelSplitState): void {
    const next = new Map(state.items.map((item) => [item.key, JSON.stringify(item)]))
    for (const [key, identity] of next) {
      if (this.identities.get(key) !== identity)
        this.versions.set(key, (this.versions.get(key) ?? 0) + 1)
    }
    this.identities = next
  }

  capture(state: PanelSplitState, key: string): PanelSplitCapture | null {
    this.synchronize(state)
    const item = state.items.find((candidate) => candidate.key === key)
    if (item === undefined)
      return null
    return { item, incarnation: this.versions.get(key) ?? 0 }
  }

  matches(state: PanelSplitState, capture: PanelSplitCapture): boolean {
    this.synchronize(state)
    const item = state.items.find((candidate) => candidate.key === capture.item.key)
    return item !== undefined
      && JSON.stringify(item) === JSON.stringify(capture.item)
      && this.versions.get(capture.item.key) === capture.incarnation
  }
}

/**
 * The stable row around a panel's content. An empty pane removes only the splitter and pane, never
 * the content slot: moving the terminal under a new parent would replace its holder without running
 * the attachment effect again. Flex and not absolute positioning lets its ResizeObserver refit
 * xterm when the visible siblings change shape, with nothing here calling `fit`.
 */
export function PanelSplitLayout(props: {
  ratio: number
  strip: React.ReactNode
  pane: React.ReactNode
  onResize(ratio: number): void
  children: React.ReactNode
}): React.JSX.Element {
  const container = useRef<HTMLDivElement>(null)
  const drag = useRef<{ pointerId: number; startX: number; startRatio: number; width: number } | null>(null)
  const onResize = props.onResize

  return (
    <div className="jamat-panel-split" ref={container}>
      <div className="jamat-panel-split__content">{props.children}</div>
      {props.pane !== null && (
        <>
          <div
            className="jamat-panel-split__splitter"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize split"
            tabIndex={0}
            onPointerDown={(event) => {
              const width = container.current?.getBoundingClientRect().width ?? 0
              if (width <= 0)
                return
              // Pointer capture rather than window listeners, the same way the sidebar's splitter does
              // it: an alt-tab in the middle of a drag must not leave a live drag record behind.
              event.currentTarget.setPointerCapture(event.pointerId)
              drag.current = {
                pointerId: event.pointerId,
                startX: event.clientX,
                startRatio: props.ratio,
                width,
              }
            }}
            onPointerMove={(event) => {
              const active = drag.current
              if (!active || active.pointerId !== event.pointerId)
                return
              onResize(PanelSplitDrag.ratioOf(
                active.startRatio,
                event.clientX - active.startX,
                active.width,
              ))
            }}
            onPointerUp={(event) => {
              event.currentTarget.releasePointerCapture(event.pointerId)
              drag.current = null
            }}
            onLostPointerCapture={() => { drag.current = null }}
            onKeyDown={(event) => {
              const step = PanelSplitDrag.stepOf(event.key)
              if (step === 0)
                return
              event.preventDefault()
              onResize(props.ratio + step)
            }}
          />
          <div
            className="jamat-panel-split__pane"
            style={{ flexBasis: `${PanelSplitParams.clampRatio(props.ratio) * 100}%` }}
          >
            {props.strip}
            <div className="jamat-panel-split__body">{props.pane}</div>
          </div>
        </>
      )}
    </div>
  )
}

/** The inner tabs. A strip and not the real tab widget: these carry no signals, no badges and no
 *  session colour, and their menu is two verbs over one document rather than the command catalog. */
export function PanelSplitStrip(props: {
  items: readonly PanelSplitItem[]
  active: string | null
  preview: string | null
  onActivate(key: string): void
  onKeepOpen(key: string): void
  onClose(key: string): void
  onDetach(key: string): void
}): React.JSX.Element {
  const [menu, setMenu] = useState<{ key: string; position: ContextMenuPosition } | null>(null)
  const onDetach = props.onDetach
  const onClose = props.onClose

  return (
    <div className="jamat-panel-split__strip" role="tablist" aria-label="Split files">
      {props.items.map((item) => (
        <div
          key={item.key}
          className={`jamat-panel-split__tab${item.key === props.active ? ' is-active' : ''}${item.key === props.preview ? ' is-preview' : ''}`}
          role="tab"
          aria-selected={item.key === props.active}
          title={item.source.path}
          onClick={() => props.onActivate(item.key)}
          onDoubleClick={() => props.onKeepOpen(item.key)}
          onContextMenu={(event) => {
            event.preventDefault()
            setMenu({ key: item.key, position: { x: event.clientX, y: event.clientY } })
          }}
        >
          <span className="jamat-panel-split__title">{item.title}</span>
          <button
            className="jamat-panel-split__close"
            type="button"
            aria-label={`Close ${item.title}`}
            onClick={(event) => {
              // Without this the click reaches the tab and activates what it is about to remove.
              event.stopPropagation()
              props.onClose(item.key)
            }}
          >
            ×
          </button>
        </div>
      ))}
      {menu !== null && (
        <ContextMenu
          position={menu.position}
          ariaLabel="Split tab actions"
          items={[
            {
              key: 'split.detach',
              label: 'Detach from split',
              onSelect: () => queueMicrotask(() => onDetach(menu.key)),
            },
            { key: 'split.close', label: 'Close', onSelect: () => onClose(menu.key) },
          ]}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}

class PanelSplitDrag {
  private static readonly keyStepConst = 0.02

  /** The pane is on the right of the splitter, so it grows as the pointer moves left. */
  static ratioOf(startRatio: number, deltaX: number, width: number): number {
    if (width <= 0)
      return PanelSplitParams.clampRatio(startRatio)
    return PanelSplitParams.clampRatio(startRatio - deltaX / width)
  }

  static stepOf(key: string): number {
    if (key === 'ArrowLeft')
      return PanelSplitDrag.keyStepConst
    else if (key === 'ArrowRight')
      return -PanelSplitDrag.keyStepConst
    else
      return 0
  }
}
