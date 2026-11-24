import type { SessionFilePorts } from '../../shared/sessionWorkspace'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { FileViewerDocumentSource } from '../../../lib-orchestrator/fileViewer/fileViewerApi.types'
import type { PanelSplitFileItem, PanelSplitReading } from '../widgets/tabs/panelSplit'
import { FileViewerContent } from './fileViewerContent'
import { FileViewerGetDocumentControl } from './fileViewerGetDocument'
import type { PromptInsertTarget } from '../shell/terminalInputRegistry'
import {
  FileViewerDiffControl,
  FileViewerFindButton,
  FileViewerReloadControl,
  FileViewerViewControl,
  FileViewerWrapControl,
  FileViewerZoomControl,
} from './fileViewerControls'
import type {
  FileChangesViewModel,
  FileChangesWorkingTreeViewModel,
} from './fileViewerPanel.types'
import { FileViewerZoom, useFileViewerZoomWheel } from './fileViewerZoom'
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
import './fileViewerPanel.css'
import './fileViewerPane.css'

export function FileViewerPane(props: {
  ref?: React.Ref<HTMLElement>
  ports: SessionFilePorts
  item: PanelSplitFileItem
  changes: FileChangesViewModel
  workingTree: FileChangesWorkingTreeViewModel
  backPath: string | null
  /** Raised by the split tab's Reload; each new value reads the file from disk again. */
  reloadRequest: number
  onBack(): void
  onClose(): void
  /** `reading` is where the reader was in this file, given when a link leaves it for another. */
  onOpenItem(item: PanelSplitFileItem, reading?: PanelSplitReading): string | null
  /** Persists the reader's scroll offset in this file while it remains active, for window reloads. */
  onRememberReading?(reading: PanelSplitReading): void
  onRefused(reason: string): void
  insertPrompt?: PromptInsertTarget
}): React.JSX.Element {
  const [toolbarSlot, setToolbarSlot] = useState<HTMLElement | null>(null)
  const model = useFileViewerDocument(
    props.item.source,
    props.item.baselineHint,
    props.changes,
    props.workingTree,
    props.ports,
  )
  // A file that is gone has nothing left to show; a refusal of any other kind stays readable.
  const onClose = props.onClose
  useEffect(() => { if (model.sourceMissing) onClose() }, [model.sourceMissing, onClose])
  const onOpenItem = props.onOpenItem
  const onRefused = props.onRefused
  const zoomPercent = FileViewerZoom.read(props.item.zoomPercent)
  const changeZoom = useCallback((percent: number): void => {
    // The split's own store, the same way a chosen baseline is kept: an item is replaced whole
    // when its file is opened again, so a zoom held outside it would be lost on the next open.
    const refusal = onOpenItem({ ...props.item, zoomPercent: percent })
    if (refusal !== null)
      onRefused(refusal)
  }, [onOpenItem, onRefused, props.item])
  const body = useFileViewerZoomWheel(zoomPercent, changeZoom)
  const wrapLines = props.item.wrapLines === true
  const changeWrap = useCallback((wrap: boolean): void => {
    const refusal = onOpenItem({ ...props.item, wrapLines: wrap ? true : undefined })
    if (refusal !== null)
      onRefused(refusal)
  }, [onOpenItem, onRefused, props.item])
  const search = useFileViewerSearch(body, () => {
    if (model.document?.kind.kind === 'html' && model.mode === 'rendered') model.setMode('raw')
  })
  // The pane mounts once per shown item, so the offset it mounted with is restored once.
  const [restore, setRestore] = useState<{ place: FileViewerPlace; afterDocumentId?: string } | undefined>(() => {
    const place = FileViewerPlace.at(props.item.scrollTop)
    return place === undefined ? undefined : { place }
  })
  const [dismissedLocation, setDismissedLocation] = useState<PanelSplitFileItem['location']>(undefined)
  const contentReady = model.document !== null && (
    model.mode === 'diff'
      ? model.diff !== null
      : FileViewerDocumentState.hasText(model.document) ? model.textReady : true
  )
  // A reload restore waits for the new grant's document id, so the old document still on screen
  // cannot activate listeners or time out the restore before the fresh content arrives.
  const restoreReady = contentReady
    && (restore?.afterDocumentId === undefined || model.document?.documentId !== restore.afterDocumentId)
  useFileViewerPlaceRestore(body, restore?.place, restoreReady, () => setRestore(undefined))
  const onRememberReading = props.onRememberReading
  const rememberReading = useCallback((scrollTop: number | undefined): void => {
    onRememberReading?.({ key: props.item.key, scrollTop })
  }, [onRememberReading, props.item.key])
  useFileViewerScrollSave(body, contentReady && restore === undefined, rememberReading)
  const modelReload = model.reload
  const currentDocumentId = model.document?.documentId
  const itemLocation = props.item.location
  // A place still being restored on a newer grant is where the reader is: the body may not show it yet.
  const reload = useCallback((): void => {
    if (itemLocation !== undefined) setDismissedLocation(itemLocation)
    setRestore((current) => {
      const place = current !== undefined && current.afterDocumentId !== currentDocumentId
        ? current.place
        : FileViewerPlace.of(body.current)
      return place === undefined ? undefined : { place, afterDocumentId: currentDocumentId }
    })
    modelReload()
  }, [body, currentDocumentId, itemLocation, modelReload])
  const freshness = useFileViewerFreshness(model.document?.documentId ?? null, reload, props.ports.viewer)
  // The value the pane mounted with is not a request: a freshly mounted pane has just read the file.
  const servedReload = useRef(props.reloadRequest)
  useEffect(() => {
    if (servedReload.current === props.reloadRequest) return
    servedReload.current = props.reloadRequest
    reload()
  }, [props.reloadRequest, reload])
  const openSource = useCallback((source: FileViewerDocumentSource): void => {
    model.openSource(source, (document) => {
      const refusal = onOpenItem({
        kind: 'file',
        key: document.documentKey,
        title: document.name,
        source: document.source,
        ...(props.item.target ? { target: props.item.target } : {}),
      }, { key: props.item.key, scrollTop: FileViewerScrollTop.of(body.current) })
      if (refusal !== null)
        onRefused(refusal)
    })
  }, [model.openSource, onOpenItem, onRefused, props.item.key, props.item.target, body])

  return (
    <section
      className="file-viewer file-viewer-pane"
      aria-label="Split file"
      ref={props.ref}
      tabIndex={-1}
      data-file-search-open={search.open || undefined}
      data-file-wrap={wrapLines || undefined}
      onKeyDown={(event) => {
        search.onKeyDown(event)
        FileViewerKeyboardScroll.handle(event, body.current)
      }}
      style={{ '--file-viewer-zoom': FileViewerZoom.scaleOf(zoomPercent) } as React.CSSProperties}
    >
      <div className="file-viewer-toolbar">
        <button
          type="button"
          className="file-viewer-back"
          aria-label={props.backPath === null ? 'Close document' : 'Back to previous document'}
          title={props.backPath === null ? 'Close document' : `Back to ${props.backPath}`}
          onClick={props.backPath === null ? props.onClose : props.onBack}
        >
          {props.backPath === null ? '× Close' : '← Back'}
        </button>
        {model.document && (
          <>
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
                  const refusal = props.onOpenItem({
                    ...props.item,
                    baselineHint: target?.hint,
                  })
                  if (refusal !== null)
                    props.onRefused(refusal)
                }}
              />
            )}
            <FileViewerZoomControl percent={zoomPercent} onChange={changeZoom} />
            <FileViewerWrapControl wrap={wrapLines} onChange={changeWrap} />
            <FileViewerFindButton onFind={search.show} />
            <FileViewerReloadControl missing={freshness.missing} onReload={reload} />
            <FileViewerGetDocumentControl document={model.document} text={model.text} />
            <span className="file-viewer-toolbar-slot" ref={setToolbarSlot} />
          </>
        )}
      </div>
      <FileViewerSearchBar search={search} />
      <div className="file-viewer-body" ref={body} tabIndex={-1}>
        {model.error && <p className="file-viewer-error">{model.error}</p>}
        {!model.error && !model.document && <p className="file-viewer-note">Opening file...</p>}
        {model.document && (
            <FileViewerContent ports={props.ports.viewer}
              insertPrompt={props.insertPrompt}
              toolbarSlot={toolbarSlot}
              document={model.document}
              mode={model.mode}
              baselines={model.baselines}
              text={model.text}
              textReady={model.textReady}
              diff={model.diff}
              wrapLines={wrapLines}
              location={props.item.location === dismissedLocation ? undefined : props.item.location}
              onOpenSource={openSource}
              onReload={reload}
            />
        )}
      </div>
    </section>
  )
}
