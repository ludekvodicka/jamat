import { useEffect, useRef, useState } from 'react'

import { FileViewerLimits } from '../../../lib-orchestrator/fileViewer/fileViewerLimits'

/**
 * A file too large or too binary to read as text, in pages.
 *
 * **Rows are the state, not bytes.** Every chunk used to be appended to one growing `Uint8Array` and
 * the rows for the WHOLE buffer rebuilt from it on every press, with a `<span>` per row and no
 * virtualisation - so twenty presses over a large binary meant twenty full rebuilds and 81 920 DOM
 * nodes. Now a chunk is turned into rows once, and the window keeps the last
 * `FileViewerLimits.hexRowsMax` of them.
 */
export function FileHexView(props: { documentId: string }): React.JSX.Element {
  const [rows, setRows] = useState<readonly FileHexRow[]>([])
  /** Where the next page starts. Held apart from the rows, which no longer start at zero. */
  const [readTo, setReadTo] = useState(0)
  const [total, setTotal] = useState(0)
  const [eof, setEof] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  /** Which document this view is showing, read after every await so a stale page cannot land. */
  const current = useRef<string | null>(null)

  /**
   * Reads one page of the file it is showing.
   *
   * The document id is carried through the await and checked after it, because this component is not
   * unmounted when the panel switches file - the same element type sits in the same place - so the
   * effect below merely runs again. Without the check, a page of the PREVIOUS file arrived after the
   * new one had started and was appended to it: the header said one file and the bytes were another,
   * and the next `Load next chunk` then asked the new document for the old one's offset.
   */
  const load = async (documentId: string, offset: number): Promise<void> => {
    setLoading(true)
    setError(null)
    const answer = await window.appClient.fileViewer.chunk(documentId, offset)
    if (documentId !== current.current) return
    setLoading(false)
    if (!answer.ok) {
      setError(answer.error)
      return
    }
    if (!answer.value.ok) {
      setError(`${answer.value.code}: ${answer.value.detail}`)
      return
    }
    const chunk = answer.value.value
    // Rows for the new bytes alone, at their real offsets in the file.
    const added = FileHexRows.of(new Uint8Array(chunk.bytes), chunk.offset)
    setRows((held) => FileHexRows.window(chunk.offset === 0 ? added : [...held, ...added]))
    setReadTo(chunk.offset + chunk.length)
    setTotal(chunk.totalSize)
    setEof(chunk.eof)
  }

  useEffect(() => {
    current.current = props.documentId
    setRows([])
    setReadTo(0)
    setTotal(0)
    setEof(false)
    void load(props.documentId, 0)
    return () => { current.current = null }
  }, [props.documentId])

  const from = rows[0]?.offset ?? 0
  return (
    <div className="file-hex">
      <div className="file-hex-summary">
        {from.toLocaleString()} - {readTo.toLocaleString()} of {total.toLocaleString()} bytes
        {from > 0 && ' (earlier pages dropped)'}
      </div>
      {error && <p className="file-viewer-error">{error}</p>}
      <pre className="file-hex-rows">
        {rows.map((row) => (
          <span key={row.offset}>
            <span className="file-hex-offset">{row.offset.toString(16).padStart(8, '0')}</span>
            {'  '}{row.hex.padEnd(47, ' ')}{'  '}{row.ascii}{'\n'}
          </span>
        ))}
      </pre>
      {!eof && (
        <button
          className="file-viewer-load-more"
          type="button"
          disabled={loading}
          onClick={() => void load(props.documentId, readTo)}
        >
          {loading ? 'Loading...' : 'Load next chunk'}
        </button>
      )}
    </div>
  )
}

interface FileHexRow {
  offset: number
  hex: string
  ascii: string
}

export class FileHexRows {
  private static readonly widthConst = 16

  /** `baseOffset` is where these bytes sit in the FILE, which is what the left column shows. */
  static of(bytes: Uint8Array, baseOffset = 0): readonly FileHexRow[] {
    const rows: FileHexRow[] = []
    for (let offset = 0; offset < bytes.length; offset += FileHexRows.widthConst) {
      const slice = bytes.slice(offset, offset + FileHexRows.widthConst)
      rows.push({
        offset: baseOffset + offset,
        hex: [...slice].map((byte) => byte.toString(16).padStart(2, '0')).join(' '),
        ascii: [...slice].map((byte) => byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.').join(''),
      })
    }
    return rows
  }

  /** The last rows that fit in the window; what fell off the front is re-read by paging back. */
  static window(rows: readonly FileHexRow[]): readonly FileHexRow[] {
    return rows.length <= FileViewerLimits.hexRowsMax
      ? rows
      : rows.slice(rows.length - FileViewerLimits.hexRowsMax)
  }
}
