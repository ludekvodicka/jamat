import type { IDockviewPanelProps } from 'dockview'
import { useCallback, useEffect, useState } from 'react'

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
  FileViewerPathControl,
  FileViewerReloadControl,
  FileViewerViewControl,
  FileViewerZoomControl,
} from './fileViewerControls'
import type {
  FileViewerBaselineHint,
  FileViewerChangedOpen,
  FileViewerPanelParams,
} from './fileViewerPanel.types'
import { FileViewerContent } from './fileViewerContent'
import { FileViewerSourceShape } from './fileViewerSourceShape'
import { PanelFileToolsRegistry } from './panelFileToolsRegistry'
import { FileViewerZoom, useFileViewerZoomWheel } from './fileViewerZoom'
import { useFileChanges } from './useFileChanges'
import { useFileViewerDocument } from './useFileViewerDocument'
import { useFileViewerFreshness } from './useFileViewerFreshness'
import { useWorkingTreeChanges } from './useWorkingTreeChanges'
import './fileViewerPanel.css'

export type FileViewerPanelProps = IDockviewPanelProps & {
  fileTools: PanelFileToolsRegistry
}

export function FileViewerPanel(props: FileViewerPanelProps): React.JSX.Element {
  // A panel is rebuilt from what the layout file holds, so its source can be one this build does
  // not know: a kind added later, a kind removed again, a hand-edited file. Throwing here would
  // take the whole window down and the layout brings the same panel back on every start, so the
  // window would never come back. The panel that cannot be read says so and the rest still draws.
  const restored = FileViewerPanelState.read(props.params)
  if (!restored.ok)
    return (
      <section className="file-viewer" aria-label="File viewer">
        <p className="file-viewer-error">{restored.detail}</p>
      </section>
    )
  return <FileViewerPanelBody {...props} restored={restored.value} />
}

function FileViewerPanelBody(
  props: FileViewerPanelProps & { restored: FileViewerPanelParams },
): React.JSX.Element {
  const params = props.restored
  const { current: currentParameters, update: updateParameters } = usePanelParameters(props)
  const sidebar = usePanelSidebar(props, 'workingTree')
  const toolsTab = PanelFileToolsRegistry.tab(sidebar.state.activeView)
  const changes = useFileChanges(
    params.sessionId,
    params.baselineHint?.workingTreeSource === undefined
      || (sidebar.state.visible && toolsTab === 'fileChanges'),
  )
  const workingTree = useWorkingTreeChanges(
    params.sessionId,
    sidebar.state.visible && toolsTab === 'workingTree',
    params.baselineHint?.workingTreeSource,
  )
  const onDocument = useCallback((
    next: FileViewerDocument,
    hint: FileViewerBaselineHint | undefined,
    persist: boolean,
  ): void => {
    props.api.setTitle(next.name)
    if (persist)
      updateParameters({
        ...currentParameters(),
        sessionId: next.source.sessionId,
        source: next.source,
        baselineHint: hint,
        location: undefined,
      })
  }, [currentParameters, props.api, updateParameters])
  const model = useFileViewerDocument(
    params.source,
    params.baselineHint,
    changes,
    workingTree,
    onDocument,
  )
  const freshness = useFileViewerFreshness(model.document?.documentId ?? null, model.reload)
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
      <FileToolsSidebar
        sessionId={params.sessionId}
        documentId={model.document?.documentId ?? null}
        selected={toolsTab}
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
        style={{
          '--file-viewer-zoom': FileViewerZoom.scaleOf(zoomPercent),
        } as React.CSSProperties}
      >
        {model.document && (
          <>
            <div className="file-viewer-toolbar">
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
                    updateParameters({
                      ...currentParameters(),
                      baselineHint: target?.hint,
                    })
                  }}
                />
              )}
              <FileViewerZoomControl percent={zoomPercent} onChange={changeZoom} />
              <FileViewerReloadControl missing={freshness.missing} onReload={model.reload} />
            </div>
            <FileViewerPathControl
              document={model.document}
              onExplorer={() => {
                sidebar.open('directoryExplorer')
              }}
            />
          </>
        )}
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
              location={params.location}
              onOpenSource={openSource}
            />
          )}
        </div>
      </section>
    </PanelSidebarLayout>
  )
}

export class FileViewerPanelState {
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
    }
  }
}
