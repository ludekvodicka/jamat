import { useCallback, useEffect } from 'react'

import type { FileViewerDocumentSource } from '../../../lib-orchestrator/fileViewer/fileViewerApi.types'
import type { PanelSplitFileItem } from '../widgets/tabs/panelSplit'
import { FileViewerContent } from './fileViewerContent'
import {
  FileViewerCopyPathButton,
  FileViewerDiffControl,
  FileViewerReloadControl,
  FileViewerViewControl,
  FileViewerZoomControl,
} from './fileViewerControls'
import type {
  FileChangesViewModel,
  FileChangesWorkingTreeViewModel,
} from './fileViewerPanel.types'
import { FileViewerZoom, useFileViewerZoomWheel } from './fileViewerZoom'
import { useFileViewerDocument } from './useFileViewerDocument'
import { useFileViewerFreshness } from './useFileViewerFreshness'
import './fileViewerPanel.css'
import './fileViewerPane.css'

export function FileViewerPane(props: {
  ref?: React.Ref<HTMLElement>
  item: PanelSplitFileItem
  changes: FileChangesViewModel
  workingTree: FileChangesWorkingTreeViewModel
  backPath: string | null
  onBack(): void
  onClose(): void
  onOpenItem(item: PanelSplitFileItem): string | null
  onRefused(reason: string): void
}): React.JSX.Element {
  const model = useFileViewerDocument(
    props.item.source,
    props.item.baselineHint,
    props.changes,
    props.workingTree,
  )
  const freshness = useFileViewerFreshness(model.document?.documentId ?? null, model.reload)
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
  const openSource = useCallback((source: FileViewerDocumentSource): void => {
    model.openSource(source, (document) => {
      const refusal = onOpenItem({
        kind: 'file',
        key: document.documentKey,
        title: document.name,
        source: document.source,
      })
      if (refusal !== null)
        onRefused(refusal)
    })
  }, [model.openSource, onOpenItem, onRefused])

  return (
    <section
      className="file-viewer file-viewer-pane"
      aria-label="Split file"
      ref={props.ref}
      tabIndex={-1}
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
            {model.document.modes.includes('diff') && (
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
            <FileViewerReloadControl missing={freshness.missing} onReload={model.reload} />
            <FileViewerCopyPathButton documentId={model.document.documentId} />
          </>
        )}
      </div>
      <div className="file-viewer-body" ref={body}>
        {model.error && <p className="file-viewer-error">{model.error}</p>}
        {!model.error && !model.document && <p className="file-viewer-note">Opening file...</p>}
        {model.document && (
          <FileViewerContent
            document={model.document}
            mode={model.mode}
            baselines={model.baselines}
            text={model.text}
            diff={model.diff}
            location={props.item.location}
            onOpenSource={openSource}
          />
        )}
      </div>
    </section>
  )
}
