import { useEffect, useMemo, useState } from 'react'
import { DiffView } from './DiffView'
import { langForPath } from '../utils/file-language'
import { substituteOrFallback } from '../../../../core/menu-core/file-diff-session'
import { useIpcQuery } from '../hooks/useIpcQuery'

interface FileDiffPaneProps {
  /** Used both for syntax-language detection and for the "Full file" disk fetch. */
  filePath: string
  /** Region-scoped composition from JSONL — always provided. */
  regionBefore: string
  regionAfter: string
  /** True when the composition glued together non-adjacent regions — disables Full file mode. */
  disjoint?: boolean
  /** Best-effort real line number for the region's first line (used in Region mode). */
  regionStartLine?: number | null
  /** Tag shown above the diff (e.g. "new file", "overwritten"). */
  label?: string | null
  /** When true, opens directly in Full-file mode. */
  defaultWholeFile?: boolean
}

/**
 * Detail-pane diff renderer for SessionChanges / FileViewer-style flows.
 * Wraps `DiffView` with a Region ↔ Full file toggle: Region renders the
 * hunk as composed from JSONL, Full file reads the current on-disk content
 * and anchors the region into it (via the same substitution helper used by
 * FileViewer's session-baseline backend), then renders the whole file with
 * the right-side minimap. Disjoint compositions can't be anchored, so the
 * Full file button is disabled in that case.
 */
export function FileDiffPane({
  filePath,
  regionBefore,
  regionAfter,
  disjoint,
  regionStartLine,
  label,
  defaultWholeFile,
}: FileDiffPaneProps) {
  const [wholeFile, setWholeFile] = useState(!!defaultWholeFile && !disjoint)

  // Disjoint means the region can't be anchored — flip back to Region mode.
  useEffect(() => {
    if (disjoint && wholeFile) setWholeFile(false)
  }, [disjoint, wholeFile])

  // Lazy disk read for Full-file mode. `clearOnRefetch:true` blanks the
  // buffer on filePath change so a stale render from a different file
  // never leaks through during the new read.
  const diskQuery = useIpcQuery<string | null>(
    () => wholeFile && window.electronAPI?.readFile ? window.electronAPI.readFile(filePath) : undefined,
    [wholeFile, filePath],
    { clearOnRefetch: true },
  )
  const diskContent = diskQuery.data
  const diskError = diskQuery.error
    ? diskQuery.error.message
    : (wholeFile && diskQuery.data === null && !diskQuery.loading ? 'Could not read file from disk' : null)

  const lang = useMemo(() => langForPath(filePath), [filePath])

  const wholeResult = useMemo(() => {
    if (!wholeFile || diskContent === null) return null
    return substituteOrFallback(diskContent, regionBefore, regionAfter, !!disjoint)
  }, [wholeFile, diskContent, regionBefore, regionAfter, disjoint])

  const showingWhole = !!wholeResult && !wholeResult.isRegionOnly

  // Decide what feeds DiffView. Substitution failure (file diverged, region
  // not found) falls back to region rendering with a "region only" label so
  // the user knows why they're not seeing the whole file.
  const renderBefore = showingWhole ? wholeResult!.beforeText : regionBefore
  const renderAfter = showingWhole ? wholeResult!.afterText : regionAfter
  const renderStartLine = showingWhole ? 1 : regionStartLine ?? null
  const fallbackTag = wholeFile && wholeResult?.isRegionOnly
    ? `region only — ${wholeResult.regionOnlyReason ?? 'unable to anchor'}`
    : null
  const renderLabel = fallbackTag
    ? label ? `${label} · ${fallbackTag}` : fallbackTag
    : label

  return (
    <div className="file-diff-pane">
      <div className="file-diff-pane-toolbar">
        <span className="file-viewer-view-modes">
          <button
            className={`notes-btn file-viewer-mode-btn${!wholeFile ? ' file-viewer-mode-btn-active' : ''}`}
            onClick={() => setWholeFile(false)}
          >Region</button>
          <button
            className={`notes-btn file-viewer-mode-btn${wholeFile ? ' file-viewer-mode-btn-active' : ''}`}
            onClick={() => setWholeFile(true)}
            disabled={!!disjoint}
            title={disjoint ? "Composition is disjoint — full file can't be anchored" : 'Show full file with diff overlay'}
          >Full file</button>
        </span>
        {wholeFile && diskContent === null && !diskError ? (
          <span className="file-diff-pane-status">Loading file…</span>
        ) : null}
        {diskError ? <span className="file-diff-pane-status file-diff-pane-error">{diskError}</span> : null}
      </div>
      <div className="file-diff-pane-body">
        <DiffView
          beforeText={renderBefore}
          afterText={renderAfter}
          startLine={renderStartLine}
          label={renderLabel}
          highlightLang={lang ?? null}
          showMinimap={showingWhole}
          maxLines={showingWhole ? 500 : 200}
        />
      </div>
    </div>
  )
}
