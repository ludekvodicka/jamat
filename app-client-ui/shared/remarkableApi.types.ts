import type { RemarkableSettingsValue } from './remarkableSettings'

export type RemarkableDependencyStatus =
  | { kind: 'ready'; bundleId: string; nodeVersion: string; cliVersion: string }
  | { kind: 'missing' | 'outdated' | 'damaged'; detail: string }
  | { kind: 'source-missing' | 'unsupported-platform'; detail: string }

export type RemarkableErrorCode =
  | 'cancelled'
  | 'credential-unavailable'
  | 'device-busy'
  | 'device-sleeping'
  | 'host-key-changed'
  | 'import-failed'
  | 'install-failed'
  | 'invalid-cli-output'
  | 'invalid-operation'
  | 'no-open-page'
  | 'nothing-open'
  | 'password-missing'
  | 'settings-incomplete'
  | 'sidecar-damaged'
  | 'sidecar-not-installed'
  | 'timeout'
  | 'unsupported-platform'
  | 'web-interface-unavailable'
  | 'cli-failed'

export type RemarkableResult<T = undefined> =
  | { ok: true; value: T }
  | { ok: false; code: RemarkableErrorCode; detail: string; retryable: boolean }

export interface RemarkableSettingsSnapshot {
  value: RemarkableSettingsValue
  passwordConfigured: boolean
}

export interface RemarkablePageChoice {
  pageId: string
  number: number
  template: string | null
  modified: boolean
}

/**
 * `currentPageNumber` is null when a document is open but the tablet does not identify a page in it,
 * which happens for real: its `cPages.lastOpened` can point at no page at all. The pages themselves
 * are still listable and renderable, so this is a document with no CURRENT page, not a failure.
 */
export interface RemarkableOpenDocumentPages {
  operationId: string
  documentName: string
  currentPageNumber: number | null
  pages: readonly RemarkablePageChoice[]
}

export interface RemarkableRenderedPage {
  /** The file that exists on disk, always absolute. */
  outputPath: string
  /**
   * What the terminal receives. Relative to the session directory when the page was stored in
   * the project, the absolute path otherwise: an agent reads the short form against its own cwd,
   * and a path outside that cwd has no short form worth writing.
   */
  insertText: string
  pageNumber: number
  documentName: string | null
}

export interface RemarkableStartedOperation {
  operationId: string
  /**
   * Why this operation is not storing where the settings say, or null when it is. Answered at the
   * start so the card can warn BEFORE a page is downloaded, not after it lands somewhere else.
   */
  storageNote: string | null
}

/**
 * What the CARD gets back when it opens: the operation the manager made, plus the one preference
 * that decides the card’s first action. Joined here rather than read by the card in a second
 * message, because the card cannot preview before this reply arrives anyway. The manager knows
 * nothing about it: an auto preview is the card asking earlier, not a different operation.
 */
export interface RemarkableOpenedOperation extends RemarkableStartedOperation {
  autoPreviewOnOpen: boolean
}

/**
 * A scaled-down render of one page, carried as bytes rather than a path: it is a picture the card
 * draws, never an import. It leaves no file behind - the render dies with its operation.
 */
export interface RemarkablePagePreview {
  pngBase64: string
  width: number
  height: number
  pageNumber: number
}

export type RemarkableRenderTarget =
  | { kind: 'current' }
  | { kind: 'listed-page'; pageId: string }
