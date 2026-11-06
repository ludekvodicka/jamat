export type FileViewerIconKind = 'wrap' | 'find' | 'reload' | 'document'

/** The toolbar's line icons, 16 px, drawn in the button's text colour. */
export function FileViewerIcon(props: { kind: FileViewerIconKind }): React.JSX.Element {
  return (
    <svg className="file-viewer-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={FileViewerIcons.path(props.kind)} />
    </svg>
  )
}

export class FileViewerIcons {
  static path(kind: FileViewerIconKind): string {
    if (kind === 'wrap') return 'M2 3.5h12M2 7.5h9.25a2.5 2.5 0 0 1 0 5H8M9.75 10.75 8 12.5l1.75 1.75M2 11.5h3'
    else if (kind === 'find') return 'M7 2.5a4.5 4.5 0 1 0 0 9a4.5 4.5 0 0 0 0-9zM10.25 10.25 14 14'
    else if (kind === 'reload') return 'M13.25 8a5.25 5.25 0 1 1-1.55-3.7M13.25 2.25v3h-3'
    else if (kind === 'document') return 'M4 1.75h5.25l2.75 2.75v9.75H4zM9 1.75v3h3M6 8h4M6 10.75h4'
    else throw new Error(`Unknown file viewer icon: ${JSON.stringify(kind)}`)
  }
}
