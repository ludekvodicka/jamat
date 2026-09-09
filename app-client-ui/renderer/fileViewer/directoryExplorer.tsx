import { Fragment, useEffect, useRef, useState } from 'react'

import type {
  FileViewerDirectory,
  FileViewerDirectoryEntry,
  FileViewerDocument,
} from '../../../lib-orchestrator/fileViewer/fileViewerApi.types'
import { DirectoryEntryContextMenu } from './directoryEntryContextMenu'
import './fileTools.css'

interface DirectoryEntryMenuState {
  entry: FileViewerDirectoryEntry
  position: { x: number; y: number }
}

export type DirectoryExplorerPathMode = 'relative' | 'absolute'
export type DirectoryExplorerRootMode = 'workspace' | 'project'

/** Where this explorer is drawn. The two places want different answers to the same three questions. */
export type DirectoryExplorerPlace = 'panel' | 'sidebar'

interface DirectoryExplorerPlaceSettings {
  entryContextMenu: boolean
  fileActivation: 'click' | 'doubleClick'
  pathMode: DirectoryExplorerPathMode
  rootMode: DirectoryExplorerRootMode
}

/**
 * The four knobs, decided once from where the explorer sits.
 *
 * Three were props, and the two callers flipped all three together - no third combination
 * exists, and none was ever wanted. Passed separately they bought branch code whose other leg could
 * not be taken. File activation follows the same boundary: a compact sidebar opens on one click,
 * while the standalone panel keeps its deliberate double click and View menu.
 */
export function directoryExplorerSettingsOf(
  place: DirectoryExplorerPlace,
): DirectoryExplorerPlaceSettings {
  if (place === 'panel')
    return {
      entryContextMenu: true,
      fileActivation: 'doubleClick',
      pathMode: 'absolute',
      rootMode: 'project',
    }
  else if (place === 'sidebar')
    return {
      entryContextMenu: false,
      fileActivation: 'click',
      pathMode: 'relative',
      rootMode: 'workspace',
    }
  else
    throw new Error(`Unknown directory explorer place: ${JSON.stringify(place)}`)
}

export interface DirectoryExplorerBreadcrumb {
  label: string
  parents: number
  current: boolean
}

export function DirectoryExplorer(props: {
  sessionId: string
  documentId: string | null
  /** Where to start, when it is not this session's own root. Main proves the path on every read. */
  targetPath: string | null
  place: DirectoryExplorerPlace
  onOpen(document: FileViewerDocument): void
}): React.JSX.Element {
  const settings = directoryExplorerSettingsOf(props.place)
  const [directory, setDirectory] = useState<FileViewerDirectory | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  /** Which navigation is the current one, so a slower answer cannot outrank a later click. */
  const navigation = useRef(0)
  const mounted = useRef(true)
  const [entryMenu, setEntryMenu] = useState<DirectoryEntryMenuState | null>(null)

  useEffect(() => {
    // The effect joins the same generation as the three navigations below, so a fresh mount retires
    // whatever a click had in flight - and a click cannot outrank the mount either.
    const current = ++navigation.current
    let alive = true
    setLoading(true)
    setError(null)
    let read
    if (props.documentId !== null)
      read = window.appClient.fileViewer.documentDirectory(props.documentId)
    else if (props.targetPath !== null)
      read = window.appClient.fileViewer.directoryAt(props.sessionId, props.targetPath)
    else if (settings.rootMode === 'workspace')
      read = window.appClient.fileViewer.rootDirectory(props.sessionId)
    else if (settings.rootMode === 'project')
      read = window.appClient.fileViewer.projectDirectory(props.sessionId)
    else
      throw new Error(`Unknown directory root mode: ${JSON.stringify(settings.rootMode)}`)
    void read.then((answer) => {
      if (!alive || current !== navigation.current) return
      setLoading(false)
      if (!answer.ok) setError(answer.error)
      else if (!answer.value.ok) setError(`${answer.value.code}: ${answer.value.detail}`)
      else setDirectory(answer.value.value)
    })
    return () => {
      alive = false
      navigation.current += 1
    }
  }, [props.documentId, props.place, props.sessionId, props.targetPath])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      navigation.current += 1
    }
  }, [])

  /**
   * One generation for the whole component, checked after every await.
   *
   * The effect above already had a guard; the three hand-written navigations below did not, so the
   * later ANSWER won rather than the later click. Two clicks into two directories - one of them on a
   * network path or with tens of thousands of entries - and the list, the breadcrumb and every
   * subsequent click belonged to the first, silently: each `openDirectory` mints a fresh id and the
   * old one stays valid, so nothing refuses and nothing says a word.
   */
  const walk = async (
    run: () => Promise<void>,
  ): Promise<void> => {
    const current = ++navigation.current
    setLoading(true)
    setError(null)
    try { await run() }
    finally { if (current === navigation.current) setLoading(false) }
  }

  const settle = (
    current: number,
    answer: Awaited<ReturnType<typeof window.appClient.fileViewer.directoryEntry>>,
  ): void => {
    if (current !== navigation.current) return
    if (!answer.ok) setError(answer.error)
    else if (!answer.value.ok) setError(`${answer.value.code}: ${answer.value.detail}`)
    else setDirectory(answer.value.value)
  }

  const update = async (
    operation: ReturnType<typeof window.appClient.fileViewer.directoryEntry>,
  ): Promise<void> => {
    await walk(async () => {
      const current = navigation.current
      settle(current, await operation)
    })
  }

  const navigateParents = async (parents: number): Promise<void> => {
    if (!directory || loading || parents === 0) return
    await walk(async () => {
      const current = navigation.current
      let next = directory
      for (let index = 0; index < parents; index += 1) {
        const answer = await window.appClient.fileViewer.parentDirectory(next.directoryId)
        if (current !== navigation.current) return
        if (!answer.ok) {
          setError(answer.error)
          return
        }
        if (!answer.value.ok) {
          setError(`${answer.value.code}: ${answer.value.detail}`)
          return
        }
        next = answer.value.value
      }
      setDirectory(next)
    })
  }

  const open = async (entry: FileViewerDirectoryEntry): Promise<void> => {
    if (!directory || !entry.openable) return
    if (entry.targetKind === 'directory') {
      await update(window.appClient.fileViewer.directoryEntry(directory.directoryId, entry.entryId))
      return
    }
    if (entry.targetKind === 'file') {
      const current = ++navigation.current
      const answer = await window.appClient.fileViewer.openEntry(directory.directoryId, entry.entryId)
      if (!mounted.current || current !== navigation.current) {
        if (answer.ok && answer.value.ok)
          await window.appClient.fileViewer.release(answer.value.value.documentId)
        return
      }
      if (!answer.ok) setError(answer.error)
      else if (!answer.value.ok) setError(`${answer.value.code}: ${answer.value.detail}`)
      else props.onOpen(answer.value.value)
      return
    }
    throw new Error(`Unknown directory entry target: ${JSON.stringify(entry.targetKind)}`)
  }

  return (
    <div className="file-tools-explorer">
      <div className="file-tools-explorer-path">
        <button
          type="button"
          disabled={!directory?.canGoParent || loading}
          aria-label="Parent directory"
          onClick={() => {
            if (directory)
              void update(window.appClient.fileViewer.parentDirectory(directory.directoryId))
          }}
        >
          ↑
        </button>
        {directory && DirectoryExplorerPresentation.usesBreadcrumb(settings.pathMode)
          ? (
            <nav
              className="file-tools-explorer-breadcrumb"
              aria-label="Directory path"
              title={directory.path}
            >
              {DirectoryExplorerPresentation.breadcrumbs(directory).map((breadcrumb, index) => (
                <Fragment key={`${breadcrumb.parents}:${breadcrumb.label}`}>
                  {index > 0 && <span aria-hidden="true">›</span>}
                  <button
                    type="button"
                    disabled={loading}
                    aria-current={breadcrumb.current ? 'page' : undefined}
                    onClick={() => void navigateParents(breadcrumb.parents)}
                  >
                    {breadcrumb.label}
                  </button>
                </Fragment>
              ))}
            </nav>
          )
          : (
            <span className="file-tools-explorer-path-display" title={directory?.path}>
              {directory ? DirectoryExplorerPresentation.path(directory, settings.pathMode) : ''}
            </span>
          )}
      </div>
      {loading && <p className="file-tools-note">Reading directory...</p>}
      {error && <p className="file-tools-error">{error}</p>}
      {directory && !loading && directory.entries.length === 0 && (
        <p className="file-tools-note">This directory is empty.</p>
      )}
      {directory && (
        <ul className="file-tools-directory-list">
          {directory.entries.map((entry) => (
            <li key={entry.entryId}>
              <button
                type="button"
                disabled={!entry.openable}
                title={entry.detail ?? entry.path}
                onContextMenu={(event) => {
                  if (!settings.entryContextMenu || !entry.openable) return
                  event.preventDefault()
                  setEntryMenu({
                    entry,
                    position: { x: event.clientX, y: event.clientY },
                  })
                }}
                onDoubleClick={() => {
                  if (entry.targetKind === 'file' && settings.fileActivation === 'doubleClick')
                    void open(entry)
                }}
                onClick={(event) => {
                  if (event.detail > 1) return
                  if (entry.targetKind === 'directory'
                    || (entry.targetKind === 'file' && settings.fileActivation === 'click'))
                    void open(entry)
                }}
              >
                <span>{DirectoryExplorerPresentation.icon(entry)}</span>
                <span>{entry.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {entryMenu && (
        <DirectoryEntryContextMenu
          entry={entryMenu.entry}
          position={entryMenu.position}
          onView={() => void open(entryMenu.entry)}
          onClose={() => setEntryMenu(null)}
        />
      )}
      {directory?.truncated && <p className="file-tools-warning">Directory listing is truncated.</p>}
    </div>
  )
}

export class DirectoryExplorerPresentation {
  static icon(entry: FileViewerDirectoryEntry): string {
    if (entry.nodeKind === 'symlink') return entry.targetKind === 'directory' ? '↪▸' : '↪'
    else if (entry.targetKind === 'directory') return '▸'
    else if (entry.targetKind === 'file') return '·'
    else return '?'
  }

  static path(directory: FileViewerDirectory, mode: DirectoryExplorerPathMode): string {
    if (mode === 'absolute') return directory.path
    else if (mode === 'relative') return directory.relativePath || '/'
    else throw new Error(`Unknown directory path mode: ${JSON.stringify(mode)}`)
  }

  static usesBreadcrumb(mode: DirectoryExplorerPathMode): boolean {
    if (mode === 'absolute') return true
    else if (mode === 'relative') return false
    else throw new Error(`Unknown directory path mode: ${JSON.stringify(mode)}`)
  }

  static breadcrumbs(directory: FileViewerDirectory): readonly DirectoryExplorerBreadcrumb[] {
    const parts = directory.relativePath.split('/').filter(Boolean)
    return [
      {
        label: directory.rootPath,
        parents: parts.length,
        current: parts.length === 0,
      },
      ...parts.map((label, index) => ({
        label,
        parents: parts.length - index - 1,
        current: index === parts.length - 1,
      })),
    ]
  }
}
