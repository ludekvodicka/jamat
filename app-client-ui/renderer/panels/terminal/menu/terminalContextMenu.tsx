import { useEffect, useState } from 'react'

import type {
  FileViewerDocument,
  FileViewerLocation,
} from '../../../../../lib-orchestrator/fileViewer/fileViewerApi.types'
import type {
  TerminalDetection,
  TerminalDetectResult,
} from '../../../../../lib-orchestrator/terminalDetector/terminalDetectorApi.types'
import type { IpcResult } from '../../../../shared/appClientUiIpc'
import { AppClientUiReport } from '../../../../shared/appClientUiReport'
import { ErrorText } from '../../../../shared/errorText'
import { IpcFailure } from '../../../ipc/ipcFailure'
import {
  ContextMenu,
  type ContextMenuAction,
  type ContextMenuEntry,
  type ContextMenuItem,
} from '../../../widgets/contextMenu'
import type { TerminalMenuContext } from '../attach/useTerminalAttachment'

/**
 * What a detection item does when it is chosen. Every one of them names a detection rather than a
 * path: the proof travels, the path stays main-side, and the label is the only thing it is read for.
 */
export interface TerminalMenuHandlers {
  openFile(requestId: string, detectionId: string, location?: FileViewerLocation): void
  /** The desktop's own reader, for a file this viewer would answer with a hex dump. */
  openExternal(requestId: string, detectionId: string): void
  openDirectory(requestId: string, detectionId: string): void
  openVsCode(requestId: string, detectionId: string): void
  openProjectVsCode(): void
  copyPath(path: string): void
  openUrl(url: string): void
}

interface TerminalDetectionMenuItems {
  openings: ContextMenuItem[]
  copyPaths: ContextMenuAction[]
}

/**
 * The terminal's menu, which is the one place in this tree where the items are FINDINGS rather than
 * the catalog. The tab's menu is the catalog drawn out; here a row exists because something was
 * detected under the click, so nothing about it can be declared ahead of time.
 *
 * This component owns two things and no more: the one `detect()` promise, and being closed. The
 * items are built by the class below, which needs no portal to be read.
 */
export function TerminalContextMenu(props: {
  context: Extract<TerminalMenuContext, { kind: 'local' }>
  sessionId: string
  openInSplit(document: FileViewerDocument, location?: FileViewerLocation): string | null
  openDirectoryAt(sessionId: string, path: string, directoryKey: string): void
  /**
   * Where a refusal goes. It used to go to `console.error` alone, and the sentence it carries is
   * written for a person with an instruction in it: the detection behind an item has a time to live,
   * and a menu open for two minutes is past it. Clicking again works, and nobody was being told so.
   */
  onRefused(reason: string): void
  onClose(): void
}): React.JSX.Element {
  /** Null while `detect()` is still out; `refused` where it answered with one, which settles it too. */
  const [found, setFound] = useState<TerminalDetectResult | 'refused' | null>(null)
  const detect = props.context.detect

  useEffect(() => {
    /*
     * The menu is on screen before this answers, and the detections drop in when it does. That is
     * the deal the second detection tier buys: it waits on a VCS status, and a menu that waited with
     * it would hang for hundreds of milliseconds on every right click.
     *
     * A menu closed before the answer lands takes the answer with it - the flag is what stops a
     * resolved promise writing into a component nobody is looking at any more.
     */
    let open = true
    void detect().then((answer) => {
      if (!open) return
      if (answer.ok) setFound(answer.value)
      else {
        AppClientUiReport.error(`${answer.error}`)
        setFound('refused')
      }
    }, (reason: unknown) => {
      // The channel itself failed rather than the handler refusing: a torn-down frame, a handler
      // that is not there. Without this arm the rejection is unhandled and the menu waits for an
      // answer that can no longer come.
      if (!open) return
      AppClientUiReport.error(`${ErrorText.of(reason)}`)
      setFound('refused')
    })
    return () => { open = false }
  }, [detect])

  const refused = props.onRefused
  const handlers: TerminalMenuHandlers = {
    openFile: (requestId, detectionId, location) => {
      void TerminalMenuActions.openFile(
        requestId,
        detectionId,
        location,
        props.openInSplit,
        refused,
      )
    },
    openExternal: (requestId, detectionId) => {
      void TerminalMenuActions.openExternal(requestId, detectionId, refused)
    },
    openDirectory: (requestId, detectionId) => {
      void TerminalMenuActions.openDirectory(requestId, detectionId, props.openDirectoryAt, refused)
    },
    openVsCode: (requestId, detectionId) => {
      void TerminalMenuActions.run(
        window.appClient.terminalMenu.openVsCode(requestId, detectionId),
        refused,
      )
    },
    openProjectVsCode: () => {
      void TerminalMenuActions.run(
        window.appClient.terminalMenu.openProjectVsCode(props.sessionId),
        refused,
      )
    },
    copyPath: (path) => {
      void TerminalMenuActions.run(window.appClient.clipboard.writeText(path), refused)
    },
    openUrl: (url) => {
      void TerminalMenuActions.run(window.appClient.fileViewer.openExternal(url), refused)
    },
  }

  return (
    <ContextMenu
      position={props.context.position}
      ariaLabel="Terminal actions"
      items={TerminalMenuItems.entriesOf(found, props.context, handlers)}
      onClose={props.onClose}
    />
  )
}

/**
 * The entries, built out of what came back. Pure on purpose: which rows a set of detections becomes
 * is the part worth testing, and none of it needs a portal.
 */
export class TerminalMenuItems {
  /**
   * How much of a value becomes a label before it is elided; a menu row is not a place for a query
   * string or for every directory between the drive and the one that was clicked.
   */
  private static readonly labelValueCharactersMaxConst = 56

  /** The whole menu appears in its final order only after the detections have settled. */
  static entriesOf(
    found: TerminalDetectResult | 'refused' | null,
    context: TerminalMenuContext,
    handlers: TerminalMenuHandlers,
  ): ContextMenuEntry[] {
    if (found === null)
      return [{ key: 'loading', label: 'Loading…', disabled: true, onSelect: () => undefined }]

    const result = found === 'refused' ? null : found
    const detections = TerminalMenuItems.ofDetections(result, handlers)
    return [
      ...detections.openings,
      {
        key: 'project-vscode',
        label: 'Open project in VS Code',
        onSelect: () => handlers.openProjectVsCode(),
      },
      ...(detections.copyPaths.length === 0
        ? []
        : [{ kind: 'separator', key: 'paths' } as ContextMenuEntry, ...detections.copyPaths]),
      { kind: 'separator', key: 'clipboard' },
      ...TerminalMenuItems.documentHalf(context),
    ]
  }

  /** What was found under the click. */
  static ofDetections(
    result: TerminalDetectResult | null,
    handlers: TerminalMenuHandlers,
  ): TerminalDetectionMenuItems {
    const items: TerminalDetectionMenuItems = { openings: [], copyPaths: [] }
    if (result === null) return items
    for (const detection of result.detections) {
      const detected = TerminalMenuItems.itemsOf(result.requestId, detection, handlers)
      items.openings.push(...detected.openings)
      items.copyPaths.push(...detected.copyPaths)
    }
    return items
  }

  /** Copy where available, paste as text, and finally the ordinary paste action. */
  static documentHalf(context: TerminalMenuContext): ContextMenuItem[] {
    const entries: ContextMenuItem[] = [
      { key: 'paste-as-text', label: 'Paste as text', onSelect: () => context.pasteAsText() },
      { key: 'paste', label: 'Paste', onSelect: () => context.paste() },
    ]
    // Absent rather than greyed out, the way the tab's menu leaves out what a session does not admit.
    if (context.hasSelection)
      entries.unshift({ key: 'copy', label: 'Copy', onSelect: () => context.copySelection() })
    return entries
  }

  private static itemsOf(
    requestId: string,
    detection: TerminalDetection,
    handlers: TerminalMenuHandlers,
  ): TerminalDetectionMenuItems {
    if (detection.kind === 'file') {
      const at = detection.line === null ? '' : `:${detection.line}`
      const location = detection.line !== null
        && Number.isSafeInteger(detection.line)
        && detection.line > 0
        ? { line: detection.line }
        : undefined
      return {
        // One opening row either way, and which one it is comes from the detection rather than from
        // the name read here: a PDF opens in this viewer as a hex dump, so the row that would show
        // it is replaced by the machine's own reader instead of standing beside it.
        openings: [detection.opensExternally
          ? {
            key: `open-external:${detection.detectionId}`,
            label: `Open ${detection.name} in external viewer`,
            onSelect: () => handlers.openExternal(requestId, detection.detectionId),
          }
          : {
            key: `open-file:${detection.detectionId}`,
            label: `Open ${detection.name}${at}`,
            onSelect: () => handlers.openFile(requestId, detection.detectionId, location),
          },
        {
          key: `vscode:${detection.detectionId}`,
          label: `Open ${detection.name} in VS Code`,
          onSelect: () => handlers.openVsCode(requestId, detection.detectionId),
        }],
        copyPaths: [{
          key: `copy-path:${detection.detectionId}`,
          label: `Copy ${detection.name} path`,
          onSelect: () => handlers.copyPath(detection.path),
        }],
      }
    }
    else if (detection.kind === 'directory') {
      const openings: ContextMenuItem[] = [
        {
          key: `open-directory:${detection.detectionId}`,
          // The whole path, where the file row carries a leaf: a file opens as a document whose tab
          // then says what it is, while a directory row is the only place `notes` is told apart
          // from the other four directories called `notes` this session has printed.
          label: `Open ${TerminalMenuItems.shortenedPath(detection.path)} in tab`,
          onSelect: () => handlers.openDirectory(requestId, detection.detectionId),
        },
      ]
      const children = TerminalMenuItems.childrenOf(requestId, detection, handlers)
      // A row with children opens them instead of acting, so the directory keeps an entry of its own.
      if (children.length > 0)
        openings.push({ key: `children:${detection.detectionId}`, label: `Files in ${detection.name}`, children })
      openings.push({
        key: `vscode:${detection.detectionId}`,
        label: `Open ${detection.name} in VS Code`,
        onSelect: () => handlers.openVsCode(requestId, detection.detectionId),
      })
      return {
        openings,
        copyPaths: [{
          key: `copy-path:${detection.detectionId}`,
          label: `Copy ${detection.name} path`,
          onSelect: () => handlers.copyPath(detection.path),
        }],
      }
    }
    else if (detection.kind === 'url')
      return {
        openings: [{
          key: `url:${detection.detectionId}`,
          label: `Open ${TerminalMenuItems.shortened(detection.url)}`,
          onSelect: () => handlers.openUrl(detection.url),
        }],
        copyPaths: [],
      }
    else
      throw new Error(`Unknown terminal detection: ${JSON.stringify(detection)}`)
  }

  private static childrenOf(
    requestId: string,
    detection: Extract<TerminalDetection, { kind: 'directory' }>,
    handlers: TerminalMenuHandlers,
  ): ContextMenuAction[] {
    // A listed child gets the same treatment as a detected file, and says so: the rows sit under one
    // another, and one of them silently going somewhere else is the part a person cannot see coming.
    const items: ContextMenuAction[] = detection.children.map((child) => child.opensExternally
      ? {
        key: `child:${child.detectionId}`,
        label: `${child.name} (external viewer)`,
        onSelect: () => handlers.openExternal(requestId, child.detectionId),
      }
      : {
        key: `child:${child.detectionId}`,
        label: child.name,
        onSelect: () => handlers.openFile(requestId, child.detectionId, undefined),
      })
    // How many were left out is not in the answer, and the directory itself is where the rest are.
    if (detection.childrenTruncated)
      items.push({
        key: `more:${detection.detectionId}`,
        label: '… more files',
        onSelect: () => handlers.openDirectory(requestId, detection.detectionId),
      })
    return items
  }

  private static shortened(url: string): string {
    if (url.length <= TerminalMenuItems.labelValueCharactersMaxConst) return url
    return `${url.slice(0, TerminalMenuItems.labelValueCharactersMaxConst - 1)}…`
  }

  /**
   * A path is read from its end, so a long one loses its middle rather than its tail. The root
   * stays: which drive or share this is is the other half of telling two paths apart. The cut lands
   * on a separator, so no row ever shows half a directory name.
   */
  private static shortenedPath(path: string): string {
    if (path.length <= TerminalMenuItems.labelValueCharactersMaxConst) return path
    const rootEnd = path.search(/[/\\]/)
    const root = rootEnd < 0 ? '' : path.slice(0, rootEnd + 1)
    const tail = path.slice(-Math.max(TerminalMenuItems.labelValueCharactersMaxConst - root.length - 1, 1))
    const separator = tail.search(/[/\\]/)
    return `${root}…${separator < 0 ? tail : tail.slice(separator)}`
  }
}

/** What a chosen item actually does, and where a refusal is said out loud. */
class TerminalMenuActions {
  /**
   * Two unwraps in order, the channel and then the library - the same shape the File Changes open
   * flow uses. The document is handed synchronously to the split and let go of straight away: the
   * pane asks for a document of its own.
   */
  static async openFile(
    requestId: string,
    detectionId: string,
    location: FileViewerLocation | undefined,
    open: (document: FileViewerDocument, location?: FileViewerLocation) => string | null,
    refused: (reason: string) => void,
  ): Promise<void> {
    const answer = await window.appClient.terminalMenu.openFile(requestId, detectionId)
    const document = answer.ok && answer.value.ok ? answer.value.value : null
    if (document === null) {
      TerminalMenuActions.report(IpcFailure.of(answer), refused)
      return
    }
    let refusal: string | null
    try {
      refusal = open(document, location)
    }
    finally {
      void window.appClient.fileViewer.release(document.documentId)
    }
    if (refusal !== null) refused(refusal)
  }

  /**
   * Two unwraps again, and the second one matters here: the desktop can refuse an open outright on a
   * machine with no reader for the type, and a row that did nothing at all would look like a dead one.
   */
  static async openExternal(
    requestId: string,
    detectionId: string,
    refused: (reason: string) => void,
  ): Promise<void> {
    const answer = await window.appClient.terminalMenu.openExternal(requestId, detectionId)
    TerminalMenuActions.report(IpcFailure.of(answer), refused)
  }

  static async openDirectory(
    requestId: string,
    detectionId: string,
    open: (sessionId: string, path: string, directoryKey: string) => void,
    refused: (reason: string) => void,
  ): Promise<void> {
    const answer = await window.appClient.terminalMenu.openDirectory(requestId, detectionId)
    const opened = answer.ok && answer.value.ok ? answer.value.value : null
    if (opened === null) {
      TerminalMenuActions.report(IpcFailure.of(answer), refused)
      return
    }
    open(opened.sessionId, opened.path, opened.directoryKey)
  }

  /** The channels whose whole answer is that they were reached. */
  static async run(
    call: Promise<IpcResult<unknown>>,
    refused: (reason: string) => void,
  ): Promise<void> {
    const answer = await call
    if (!answer.ok) TerminalMenuActions.report(answer.error, refused)
  }

  /** Both: the console for whoever is debugging, and the panel for whoever clicked. */
  private static report(reason: string | null, refused: (reason: string) => void): void {
    if (reason === null) return
    AppClientUiReport.error(`${reason}`)
    refused(reason)
  }
}
