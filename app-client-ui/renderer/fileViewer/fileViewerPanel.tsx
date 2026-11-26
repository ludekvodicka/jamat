import { SessionWorkspaceTargets, type SessionFilePorts } from '../../shared/sessionWorkspace'
import type { AppClientUiBridge } from '../../shared/appClientUiIpc'
import type { IDockviewPanelProps } from 'dockview'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'

import type {
  FileViewerDocument,
  FileViewerDocumentSource,
} from '../../../lib-orchestrator/fileViewer/fileViewerApi.types'
import { ErrorText } from '../../shared/errorText'
import { JsonShape } from '../../shared/jsonShape'
import { SidebarDock } from '../widgets/sidebar/sidebarDock'
import { PanelSidebarLayout, usePanelSidebar } from '../widgets/tabs/panelSidebar'
import { usePanelParameters } from '../widgets/tabs/panelParameters'
import { FileToolsSidebar } from './fileToolsSidebar'
import {
  FileViewerDiffControl,
  FileViewerFindButton,
  FileViewerPathControl,
  FileViewerReloadControl,
  FileViewerViewControl,
  FileViewerWrapControl,
  FileViewerZoomControl,
} from './fileViewerControls'
import type {
  FileViewerBaselineHint,
  FileViewerChangedOpen,
  FileViewerPanelParams,
  FileViewerPanelVisit,
} from './fileViewerPanel.types'
import { FileViewerContent } from './fileViewerContent'
import { FileViewerGetDocumentControl } from './fileViewerGetDocument'
import type { TerminalInputRegistry } from '../shell/terminalInputRegistry'
import type { PanelHistoryDirection, PanelHistoryRegistry } from '../shell/panelHistoryRegistry'
import { FileViewerSourceShape } from './fileViewerSourceShape'
import { PanelFileToolsRegistry } from './panelFileToolsRegistry'
import { FileViewerZoom, useFileViewerZoomWheel } from './fileViewerZoom'
import { useFileChanges } from './useFileChanges'
import { FileViewerDocumentState, useFileViewerDocument } from './useFileViewerDocument'
import { useFileViewerFreshness } from './useFileViewerFreshness'
import { FileViewerSearchBar, useFileViewerSearch } from './fileViewerSearch'
import { FileViewerKeyboardScroll } from './fileViewerKeyboardScroll'
import {
  FileViewerPlace,
  FileViewerScrollTop,
  useFileViewerPlaceRestore,
  useFileViewerScrollSave,
} from './fileViewerScrollRestore'
import { useWorkingTreeChanges } from './useWorkingTreeChanges'
import './fileViewerPanel.css'

export type FileViewerPanelProps = IDockviewPanelProps & {
  ports: SessionFilePorts
  changesPorts: AppClientUiBridge['fileChanges'] | null
  fileTools: PanelFileToolsRegistry
  history: PanelHistoryRegistry
  inputs?: TerminalInputRegistry
}

export function FileViewerPanel(props: FileViewerPanelProps): React.JSX.Element {
  // A panel is rebuilt from what the layout file holds, so its source can be one this build does
  // not know: a kind added later, a kind removed again, a hand-edited file. Throwing here would
  // take the whole window down and the layout brings the same panel back on every start, so the
  // window would never come back. The panel that cannot be read says so and the rest still draws.
  const restored = FileViewerPanelState.read(props.params)
  if (!restored.ok)
    return (
      <section className="file-viewer" aria-label="File viewer" tabIndex={-1}>
        <p className="file-viewer-error">{restored.detail}</p>
      </section>
    )
  return <FileViewerPanelBody {...props} restored={restored.value} />
}

function FileViewerPanelBody(
  props: FileViewerPanelProps & { restored: FileViewerPanelParams },
): React.JSX.Element {
  const params = props.restored
  const target = SessionWorkspaceTargets.panel(params)
  const insertPrompt = useSyncExternalStore(
    useCallback((changed) => props.inputs?.subscribePrompts(changed) ?? (() => {}), [props.inputs]),
    useCallback(() => {
      switch (target.kind) {
        case 'local': return props.inputs?.promptTarget(params.sessionId)
        case 'remote': return undefined
        default: throw new Error(`Unknown terminal target: ${target satisfies never}`)
      }
    }, [props.inputs, target.kind, params.sessionId]),
  )
  const { current: currentParameters, update: updateParameters } = usePanelParameters(props)
  const sidebar = usePanelSidebar(props, 'workingTree')
  const toolsTab = PanelFileToolsRegistry.tab(sidebar.state.activeView)
  const ports = props.ports
  const changes = useFileChanges(
    params.sessionId,
    props.changesPorts,
    params.baselineHint?.workingTreeSource === undefined
      || (sidebar.state.visible && toolsTab === 'fileChanges'),
  )
  const workingTree = useWorkingTreeChanges(
    params.sessionId,
    props.changesPorts?.workingTree ?? null,
    sidebar.state.visible && toolsTab === 'workingTree',
    params.baselineHint?.workingTreeSource,
  )
  // The document on screen, which a link, File Tools, Back or Forward leaves behind. It and the
  // body's offset are read before the next document is drawn.
  const shown = useRef<FileViewerDocument | null>(null)
  const [consumedRestore, setConsumedRestore] = useState<string | null>(null)
  const onDocument = useCallback((
    next: FileViewerDocument,
    hint: FileViewerBaselineHint | undefined,
    persist: boolean,
  ): void => {
    props.api.setTitle(next.name)
    if (!persist) return
    setConsumedRestore(null)
    const current = currentParameters()
    updateParameters({
      ...current,
      sessionId: next.source.sessionId,
      source: next.source,
      baselineHint: hint,
      location: undefined,
      ...FileViewerPanelState.opened(current, shown.current, next, FileViewerScrollTop.of(body.current)),
      restoreScroll: undefined,
    })
  }, [currentParameters, props.api, updateParameters])
  const model = useFileViewerDocument(
    params.source,
    params.baselineHint,
    changes,
    workingTree,
    ports,
    onDocument,
  )
  // A document that failed to replace this one is not on screen as the source, so it has no offset.
  useLayoutEffect(() => { shown.current = model.error ? null : model.document })
  // A file that is gone has nothing left to show; a refusal of any other kind stays readable.
  useEffect(() => { if (model.sourceMissing) props.api.close() }, [model.sourceMissing, props.api])
  // Held here as well as written, the way the split beside it holds its own: the parameters are
  // where a zoom SURVIVES, and a panel that waited for them to come back would redraw one round
  // trip after the press. The effect is what carries a zoom that arrives from anywhere else - a
  // restored layout, another writer - onto this panel.
  const [zoomPercent, setZoomPercent] = useState(params.zoomPercent)
  useEffect(() => { setZoomPercent(params.zoomPercent) }, [params.zoomPercent])
  const changeZoom = useCallback((percent: number): void => {
    setZoomPercent(percent)
    updateParameters({ ...currentParameters(), zoomPercent: percent })
  }, [currentParameters, updateParameters])
  const body = useFileViewerZoomWheel(zoomPercent, changeZoom)
  const restore = params.restoreScroll
  const restoreKey = restore === undefined ? null : `${restore.documentKey}:${restore.scrollTop}`
  const shownKey = model.document?.documentKey
  const shownDocumentId = model.document?.documentId
  // A visit's offset waits for its own document; a reload's place waits for the new grant id.
  const visitReady = restore !== undefined && restoreKey !== consumedRestore && shownKey === restore.documentKey
  const visitPlace = useMemo(() => FileViewerPlace.at(restore?.scrollTop), [restore?.scrollTop])
  const [reloadPlace, setReloadPlace] = useState<{
    documentKey: string
    afterDocumentId: string | undefined
    place: FileViewerPlace
  } | undefined>(undefined)
  const [dismissedLocation, setDismissedLocation] = useState<FileViewerPanelParams['location']>(undefined)
  const reloadReady = reloadPlace !== undefined
    && shownKey === reloadPlace.documentKey
    && shownDocumentId !== reloadPlace.afterDocumentId
  // A reload that never landed must not put a later document, or a later visit of this one, there.
  useEffect(() => { if (reloadPlace !== undefined && shownKey !== reloadPlace.documentKey) setReloadPlace(undefined) }, [reloadPlace, shownKey])
  const contentReady = model.document !== null && (
    model.mode === 'diff'
      ? model.diff !== null
      : FileViewerDocumentState.hasText(model.document) ? model.textReady : true
  )
  const place = reloadPlace !== undefined ? (reloadReady ? reloadPlace.place : undefined) : visitReady ? visitPlace : undefined
  useFileViewerPlaceRestore(body, place, contentReady, () => {
    setReloadPlace(undefined)
    if (visitReady) setConsumedRestore(restoreKey)
  })
  const rememberReading = useCallback((scrollTop: number | undefined): void => {
    if (shownKey === undefined) return
    const next = scrollTop === undefined ? undefined : { documentKey: shownKey, scrollTop }
    const nextKey = next === undefined ? null : `${next.documentKey}:${next.scrollTop}`
    setConsumedRestore(nextKey)
    const current = currentParameters()
    const currentRestore = FileViewerPanelState.read(current)
    const sameRestore = currentRestore.ok
      && currentRestore.value.restoreScroll?.documentKey === next?.documentKey
      && currentRestore.value.restoreScroll?.scrollTop === next?.scrollTop
      && currentRestore.value.location === undefined
    if (sameRestore) return
    updateParameters({ ...current, location: undefined, restoreScroll: next })
  }, [currentParameters, shownKey, updateParameters])
  useFileViewerScrollSave(body, contentReady && reloadPlace === undefined && !visitReady, rememberReading)
  const modelReload = model.reload
  const paramLocation = params.location
  // A place still being restored on a newer grant is where the reader is: the body may not show it yet.
  const reload = useCallback((): void => {
    if (paramLocation !== undefined) setDismissedLocation(paramLocation)
    if (shownKey === undefined) { modelReload(); return }
    setReloadPlace((current) => {
      const captured = current !== undefined && current.documentKey === shownKey && current.afterDocumentId !== shownDocumentId
        ? current.place
        : visitReady && visitPlace !== undefined
          ? visitPlace
          : FileViewerPlace.of(body.current)
      return captured === undefined ? undefined : { documentKey: shownKey, afterDocumentId: shownDocumentId, place: captured }
    })
    modelReload()
  }, [body, modelReload, paramLocation, shownDocumentId, shownKey, visitPlace, visitReady])
  const [panelVisible, setPanelVisible] = useState(props.api.isVisible)
  useEffect(() => {
    setPanelVisible(props.api.isVisible)
    const subscription = props.api.onDidVisibilityChange(event => setPanelVisible(event.isVisible))
    return () => subscription.dispose()
  }, [props.api])
  const freshness = useFileViewerFreshness(model.document?.documentId ?? null, reload, ports.viewer, panelVisible)
  const step = useCallback((direction: PanelHistoryDirection): void => {
    const current = currentParameters()
    const leaving = FileViewerPanelState.visitOf(current, shown.current, FileViewerScrollTop.of(body.current))
    const next = FileViewerPanelState.stepped(current, direction, leaving)
    if (next !== null) {
      setConsumedRestore(null)
      updateParameters(next)
    }
  }, [body, currentParameters, updateParameters])
  useEffect(() => props.history.register(props.api.id, step), [props.api.id, props.history, step])
  const backTo = params.history.at(-1)
  // Held and written the way the zoom above is, for the same reason.
  const [wrapLines, setWrapLines] = useState(params.wrapLines)
  const [toolbarSlot, setToolbarSlot] = useState<HTMLElement | null>(null)
  useEffect(() => { setWrapLines(params.wrapLines) }, [params.wrapLines])
  const changeWrap = useCallback((wrap: boolean): void => {
    setWrapLines(wrap)
    updateParameters({ ...currentParameters(), wrapLines: wrap })
  }, [currentParameters, updateParameters])
  const search = useFileViewerSearch(body, () => {
    if (model.document?.kind.kind === 'html' && model.mode === 'rendered') model.setMode('raw')
  })

  useEffect(() => props.fileTools.register(props.api.id, {
    toggle: sidebar.toggle,
    open: sidebar.open,
  }), [props.api.id, props.fileTools, sidebar.open, sidebar.toggle])

  const openChanged = (value: FileViewerChangedOpen): void => {
    model.adopt(value.document, value.baselineHint ?? undefined)
  }
  const openDocument = (next: FileViewerDocument): void => model.adopt(next, undefined)
  const openSource = useCallback((source: FileViewerDocumentSource): void => {
    model.openSource(source)
  }, [model.openSource])

  const sidebarView = (
    <SidebarDock
      side="right"
      title="File tools"
      width={sidebar.state.width}
      hidden={!sidebar.state.visible}
      onResize={sidebar.resize}
      onClose={sidebar.toggle}
    >
      <FileToolsSidebar changesPorts={props.changesPorts ?? undefined} release={ports.viewer.release} directoryPorts={ports.directories}
        sessionId={params.sessionId}
        documentId={model.document?.documentId ?? null}
        selected={toolsTab}
        visible={sidebar.state.visible}
        changes={changes}
        workingTree={workingTree}
        onSelect={sidebar.open}
        onOpenChanged={openChanged}
        onOpenDocument={openDocument}
      />
    </SidebarDock>
  )

  return (
    <PanelSidebarLayout side="right" sidebar={sidebarView}>
      {/* The zoom reaches the body's own size calc and the media frame from one property here,
          inherited by everything the panel draws rather than threaded through props. */}
      <section
        className="file-viewer"
        aria-label="File viewer"
        tabIndex={-1}
        data-file-search-open={search.open || undefined}
        data-file-wrap={wrapLines || undefined}
        onKeyDown={(event) => {
          search.onKeyDown(event)
          FileViewerKeyboardScroll.handle(event, body.current)
        }}
        style={{
          '--file-viewer-zoom': FileViewerZoom.scaleOf(zoomPercent),
        } as React.CSSProperties}
      >
        {model.document && (
          <>
            <div className="file-viewer-toolbar">
              {backTo !== undefined && (
                <button type="button" className="file-viewer-back" aria-label="Back to previous document"
                  title={`Back to ${backTo.source.path}`} onClick={() => step('back')}>← Back</button>
              )}
              <FileViewerViewControl
                modes={model.document.modes}
                value={model.mode}
                onChange={model.setMode}
              />
              {model.mode === 'diff' && (
                <FileViewerDiffControl
                  targets={model.targets}
                  value={model.diffTarget}
                  onChange={(target) => {
                    model.setDiffTarget(target)
                    updateParameters({
                      ...currentParameters(),
                      baselineHint: target?.hint,
                    })
                  }}
                />
              )}
              <FileViewerZoomControl percent={zoomPercent} onChange={changeZoom} />
              <FileViewerWrapControl wrap={wrapLines} onChange={changeWrap} />
              <FileViewerFindButton onFind={search.show} />
              <FileViewerReloadControl missing={freshness.missing} onReload={reload} />
              <FileViewerGetDocumentControl document={model.document} text={model.text} />
              <span className="file-viewer-toolbar-slot" ref={setToolbarSlot} />
            </div>
            <FileViewerPathControl
              document={model.document}
              onExplorer={() => {
                sidebar.open('directoryExplorer')
              }}
            />
          </>
        )}
        <FileViewerSearchBar search={search} />
        <div className="file-viewer-body" ref={body} tabIndex={-1}>
          {model.error && <p className="file-viewer-error">{model.error}</p>}
          {!model.error && !model.document && <p className="file-viewer-note">Opening file...</p>}
          {model.document && (
              <FileViewerContent ports={ports.viewer}
                insertPrompt={insertPrompt}
                toolbarSlot={toolbarSlot}
                document={model.document}
                mode={model.mode}
                baselines={model.baselines}
                text={model.text}
                textReady={model.textReady}
                diff={model.diff}
                wrapLines={wrapLines}
                location={params.location === dismissedLocation ? undefined : params.location}
                onOpenSource={openSource}
                onReload={reload}
              />
          )}
        </div>
      </section>
    </PanelSidebarLayout>
  )
}

export class FileViewerPanelState {
  static readonly historyMaxConst = 50

  static read(value: Record<string, unknown>):
    | { ok: true; value: FileViewerPanelParams }
    | { ok: false; detail: string } {
    try { return { ok: true, value: FileViewerPanelState.params(value) } }
    catch (reason) {
      return { ok: false, detail: ErrorText.of(reason) }
    }
  }

  static params(value: Record<string, unknown>): FileViewerPanelParams {
    const sessionId = value.sessionId
    const source = value.source
    if (typeof sessionId !== 'string' || !sessionId)
      throw new Error(`File viewer has no session: ${JSON.stringify(value)}`)
    if (!JsonShape.isRecord(source))
      throw new Error(`File viewer has no source: ${JSON.stringify(value)}`)
    // The shape is read once, in the class both this panel and a split item ask; the panel adds
    // the one rule that is its own, that the source belongs to the session the tab was opened for.
    const read = FileViewerSourceShape.read(source)
    if (read === null || read.sessionId !== sessionId)
      throw new Error(`Unknown file viewer source: ${JSON.stringify(source)}`)
    return {
      ...value,
      sessionId,
      source: read,
      baselineHint: FileViewerSourceShape.hint(value.baselineHint),
      location: FileViewerSourceShape.location(value.location),
      zoomPercent: FileViewerZoom.read(value.zoomPercent),
      wrapLines: value.wrapLines === true,
      history: FileViewerPanelState.visits(value.history),
      forward: FileViewerPanelState.visits(value.forward),
      restoreScroll: FileViewerPanelState.restoreScroll(value.restoreScroll),
    }
  }

  /**
   * The panel's own source as a visit, with the offset of `shown` when it is drawn. Null for
   * parameters without a readable source.
   */
  static visitOf(
    value: Record<string, unknown>,
    shown: FileViewerDocument | null,
    scrollTop: number | undefined,
  ): FileViewerPanelVisit | null {
    const source = FileViewerSourceShape.read(value.source)
    if (source === null)
      return null
    const baselineHint = FileViewerSourceShape.hint(value.baselineHint)
    return {
      source,
      ...(baselineHint === undefined ? {} : { baselineHint }),
      ...(shown === null || scrollTop === undefined ? {} : { restoreScroll: { documentKey: shown.documentKey, scrollTop } }),
    }
  }

  /**
   * The lists after `next` replaced `shown`: a new visit, and no Forward left. Showing the same
   * document again, a reload or a new baseline of it, is no visit and keeps both.
   */
  static opened(
    value: Record<string, unknown>,
    shown: FileViewerDocument | null,
    next: FileViewerDocument,
    scrollTop: number | undefined,
  ): { history: readonly FileViewerPanelVisit[]; forward: readonly FileViewerPanelVisit[] } {
    const history = FileViewerPanelState.visits(value.history)
    if (shown?.documentKey === next.documentKey)
      return { history, forward: FileViewerPanelState.visits(value.forward) }
    const visit = FileViewerPanelState.visitOf(value, shown, scrollTop)
    return { history: visit === null ? history : FileViewerPanelState.added(history, visit), forward: [] }
  }

  /**
   * The parameters after Back or Forward, or null without a visit that way. `leaving` joins the
   * other list, so the step can be undone; the step itself adds no visit.
   */
  static stepped(
    value: Record<string, unknown>,
    direction: PanelHistoryDirection,
    leaving: FileViewerPanelVisit | null,
  ): Record<string, unknown> | null {
    const history = FileViewerPanelState.visits(value.history)
    const forward = FileViewerPanelState.visits(value.forward)
    let from: readonly FileViewerPanelVisit[]
    let to: readonly FileViewerPanelVisit[]
    if (direction === 'back') { from = history; to = forward }
    else if (direction === 'forward') { from = forward; to = history }
    else throw new Error(`Unknown history direction: ${direction satisfies never}`)
    const visit = from.at(-1)
    if (visit === undefined)
      return null
    const left = from.slice(0, -1)
    const reached = leaving === null ? to : FileViewerPanelState.added(to, leaving)
    return {
      ...value,
      sessionId: visit.source.sessionId,
      source: visit.source,
      baselineHint: visit.baselineHint,
      location: undefined,
      history: direction === 'back' ? left : reached,
      forward: direction === 'back' ? reached : left,
      restoreScroll: visit.restoreScroll,
    }
  }

  private static added(visits: readonly FileViewerPanelVisit[], visit: FileViewerPanelVisit): readonly FileViewerPanelVisit[] {
    return [...visits, visit].slice(-FileViewerPanelState.historyMaxConst)
  }

  private static visits(value: unknown): readonly FileViewerPanelVisit[] {
    if (!Array.isArray(value))
      return []
    return value.slice(-FileViewerPanelState.historyMaxConst).flatMap((entry): FileViewerPanelVisit[] => {
      if (!JsonShape.isRecord(entry))
        return []
      const source = FileViewerSourceShape.read(entry.source)
      if (source === null)
        return []
      const baselineHint = FileViewerSourceShape.hint(entry.baselineHint)
      const restoreScroll = FileViewerPanelState.restoreScroll(entry.restoreScroll)
      return [{
        source,
        ...(baselineHint === undefined ? {} : { baselineHint }),
        ...(restoreScroll === undefined ? {} : { restoreScroll }),
      }]
    })
  }

  private static restoreScroll(value: unknown): FileViewerPanelParams['restoreScroll'] {
    if (!JsonShape.isRecord(value) || typeof value.documentKey !== 'string' || !value.documentKey)
      return undefined
    const scrollTop = FileViewerScrollTop.read(value.scrollTop)
    return scrollTop === undefined ? undefined : { documentKey: value.documentKey, scrollTop }
  }
}
