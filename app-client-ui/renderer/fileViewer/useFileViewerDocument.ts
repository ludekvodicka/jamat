import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import type { FileDiffResult } from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import type {
  FileViewerDocument,
  FileViewerDocumentSource,
  FileViewerTextResult,
  FileViewerViewMode,
} from '../../../lib-orchestrator/fileViewer/fileViewerApi.types'
import { ErrorText } from '../../shared/errorText'
import type { FileViewerBaselineState } from './fileViewerContent'
import {
  FileViewerDiffTargets,
  type FileViewerDiffTarget,
} from './fileViewerControls'
import type {
  FileChangesViewModel,
  FileChangesWorkingTreeViewModel,
  FileViewerBaselineHint,
} from './fileViewerPanel.types'

export interface FileViewerDocumentModel {
  document: FileViewerDocument | null
  error: string | null
  mode: FileViewerViewMode
  setMode(mode: FileViewerViewMode): void
  text: FileViewerTextResult | null
  diff: FileDiffResult | null
  targets: readonly FileViewerDiffTarget[]
  diffTarget: FileViewerDiffTarget | null
  setDiffTarget(target: FileViewerDiffTarget | null): void
  baselines: FileViewerBaselineState
  /** Takes ownership of a document grant already opened by File Changes or Explorer. */
  adopt(document: FileViewerDocument, hint: FileViewerBaselineHint | undefined): void
  /**
   * The same file again, from disk, keeping the view mode, the chosen baseline and what is drawn
   * until the fresh text lands - so an automatic reload does not scroll a reader back to the top.
   */
  reload(): void
  /**
   * With no callback, replaces this viewer's document. With a callback, lends the restored
   * document for a synchronous source-only handoff and releases its grant immediately afterwards.
   */
  openSource(
    source: FileViewerDocumentSource,
    onOpened?: (document: FileViewerDocument) => void,
  ): void
}

export function useFileViewerDocument(
  source: FileViewerDocumentSource,
  sourceBaselineHint: FileViewerBaselineHint | undefined,
  changes: FileChangesViewModel,
  workingTree: FileChangesWorkingTreeViewModel,
  onDocument?: (
    document: FileViewerDocument,
    hint: FileViewerBaselineHint | undefined,
    persist: boolean,
  ) => void,
): FileViewerDocumentModel {
  const sourceKey = JSON.stringify(source)
  const sourceBaselineHintKey = JSON.stringify(sourceBaselineHint ?? null)
  const [documentValue, setDocument] = useState<FileViewerDocument | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<FileViewerViewMode>('raw')
  const [text, setText] = useState<FileViewerTextResult | null>(null)
  const [diff, setDiff] = useState<FileDiffResult | null>(null)
  const [baselineHint, setBaselineHint] = useState<FileViewerBaselineHint | undefined>(
    sourceBaselineHint,
  )
  const [diffTarget, setDiffTargetValue] = useState<FileViewerDiffTarget | null>(null)
  const writtenSource = useRef<string | null>(null)
  const opening = useRef(0)
  const mounted = useRef(true)
  const ownedDocumentId = useRef<string | null>(null)
  /** A reload keeps the previous text on screen; the read below must not blank it first. */
  const keepingText = useRef(false)
  const sourceBaselineHintRef = useRef(sourceBaselineHint)
  const onDocumentRef = useRef(onDocument)

  useLayoutEffect(() => {
    sourceBaselineHintRef.current = sourceBaselineHint
    onDocumentRef.current = onDocument
  })

  useLayoutEffect(() => {
    opening.current += 1
  }, [sourceKey])

  const release = useCallback((documentId: string): void => {
    void window.appClient.fileViewer.release(documentId)
  }, [])

  const accept = useCallback((
    next: FileViewerDocument,
    hint: FileViewerBaselineHint | undefined,
    persist: boolean,
    keepView = false,
  ): void => {
    opening.current += 1
    if (!mounted.current) {
      release(next.documentId)
      return
    }
    const previousDocumentId = ownedDocumentId.current
    ownedDocumentId.current = next.documentId
    if (previousDocumentId !== null && previousDocumentId !== next.documentId)
      release(previousDocumentId)
    setDocument(next)
    setError(null)
    setBaselineHint(hint)
    if (keepView) {
      // The same file, so what was on screen stays on screen: only a mode the new document no
      // longer offers - a text file that became a binary one - is given up.
      keepingText.current = true
      setMode((current) => next.modes.includes(current)
        ? current
        : FileViewerDocumentState.defaultMode(next.modes))
    }
    else {
      setText(null)
      setDiff(null)
      setMode(hint && next.modes.includes('diff')
        ? 'diff'
        : FileViewerDocumentState.defaultMode(next.modes))
    }
    if (persist)
      writtenSource.current = JSON.stringify(next.source)
    onDocumentRef.current?.(next, hint, persist)
  }, [release])

  const request = useCallback((
    nextSource: FileViewerDocumentSource,
    consume: (document: FileViewerDocument) => boolean,
  ): void => {
    const current = ++opening.current
    setError(null)
    void window.appClient.fileViewer.restore(nextSource, true).then((answer) => {
      if (current !== opening.current) {
        if (answer.ok && answer.value.ok)
          release(answer.value.value.documentId)
        return
      }
      if (!answer.ok) {
        setError(answer.error)
        return
      }
      if (!answer.value.ok) {
        setError(`${answer.value.code}: ${answer.value.detail}`)
        return
      }
      const document = answer.value.value
      try {
        if (!consume(document))
          release(document.documentId)
      }
      catch (reason) {
        if (ownedDocumentId.current !== document.documentId)
          release(document.documentId)
        setError(ErrorText.of(reason))
      }
    })
  }, [release])

  useEffect(() => {
    if (writtenSource.current === sourceKey) {
      writtenSource.current = null
      return
    }
    writtenSource.current = null
    request(source, (next) => {
      accept(next, sourceBaselineHintRef.current, false)
      return true
    })
  }, [accept, request, sourceKey])

  useLayoutEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      opening.current += 1
      const documentId = ownedDocumentId.current
      ownedDocumentId.current = null
      if (documentId !== null) release(documentId)
    }
  }, [release])

  useEffect(() => {
    setBaselineHint(sourceBaselineHint)
    if (sourceBaselineHint && documentValue?.modes.includes('diff'))
      setMode('diff')
  }, [sourceBaselineHintKey])

  useEffect(() => {
    if (documentValue === null || !FileViewerDocumentState.hasText(documentValue)) {
      keepingText.current = false
      setText(null)
      return
    }
    let alive = true
    if (keepingText.current) keepingText.current = false
    else setText(null)
    void window.appClient.fileViewer.text(documentValue.documentId).then((answer) => {
      if (!alive) return
      setText(answer.ok
        ? answer.value
        : { ok: false, code: 'document-expired', detail: answer.error })
    })
    return () => { alive = false }
  }, [documentValue?.documentId])

  const targets = useMemo(
    () => FileViewerDiffTargets.of(
      changes.snapshot,
      changes.groups,
      documentValue?.path ?? '',
      workingTree.snapshots,
    ),
    [changes.groups, changes.snapshot, documentValue?.path, workingTree.snapshots],
  )

  useEffect(() => {
    setDiffTargetValue((current) => FileViewerDiffTargets.keep(current, targets, baselineHint))
  }, [baselineHint, targets])

  useEffect(() => {
    if (mode !== 'diff' || diffTarget === null) {
      setDiff(null)
      return
    }
    let alive = true
    setDiff(null)
    void window.appClient.fileChanges.diff({
      snapshotId: diffTarget.snapshotId,
      fileId: diffTarget.fileId,
      baselineId: diffTarget.baseline.baselineId,
    }).then((answer) => {
      if (!alive) return
      setDiff(answer.ok
        ? answer.value
        : { ok: false, code: 'snapshot-expired', detail: answer.error })
    })
    return () => { alive = false }
  }, [diffTarget?.snapshotId, diffTarget?.baseline.baselineId, diffTarget?.fileId, mode])

  const setDiffTarget = useCallback((target: FileViewerDiffTarget | null): void => {
    setDiffTargetValue(target)
    setBaselineHint(target?.hint)
    if (target !== null)
      setMode('diff')
  }, [])

  /**
   * The diff is asked for again as well, and only the listing the chosen baseline came out of: a
   * file that changed on disk changes the current side of its diff, and re-reading the text while
   * leaving the hunks alone would draw the reader a diff that is stale on one side only.
   */
  const reload = useCallback((): void => {
    if (documentValue === null) return
    request(documentValue.source, (next) => {
      accept(next, baselineHint, false, true)
      return true
    })
    if (mode !== 'diff') return
    if (diffTarget?.hint.workingTreeSource === undefined) void changes.reload()
    else void workingTree.reload()
  }, [accept, baselineHint, changes, diffTarget, documentValue, mode, request, workingTree])

  const adopt = useCallback((
    next: FileViewerDocument,
    hint: FileViewerBaselineHint | undefined,
  ): void => accept(next, hint, true), [accept])

  const openSource = useCallback((
    nextSource: FileViewerDocumentSource,
    onOpened?: (document: FileViewerDocument) => void,
  ): void => {
    request(nextSource, (next) => {
      if (onOpened === undefined) {
        accept(next, undefined, true)
        return true
      }
      onOpened(next)
      return false
    })
  }, [accept, request])

  return {
    document: documentValue,
    error,
    mode,
    setMode,
    text,
    diff,
    targets,
    diffTarget,
    setDiffTarget,
    baselines: {
      error: diffTarget?.hint.workingTreeSource === undefined
        ? changes.error
        : workingTree.requiredError,
      loading: diffTarget?.hint.workingTreeSource === undefined
        ? changes.loading
        : workingTree.requiredLoading,
      chosen: diffTarget !== null,
    },
    adopt,
    reload,
    openSource,
  }
}

export class FileViewerDocumentState {
  static defaultMode(modes: readonly FileViewerViewMode[]): FileViewerViewMode {
    if (modes.includes('rendered')) return 'rendered'
    else if (modes.includes('preview')) return 'preview'
    else if (modes.includes('raw')) return 'raw'
    else if (modes.includes('hex')) return 'hex'
    else if (modes.includes('diff')) return 'diff'
    else throw new Error('The document has no view mode')
  }

  static hasText(document: FileViewerDocument): boolean {
    const kind = document.kind
    if (kind.kind === 'markdown' || kind.kind === 'code' || kind.kind === 'text'
      || kind.kind === 'svg' || kind.kind === 'html')
      return true
    else if (kind.kind === 'image' || kind.kind === 'video' || kind.kind === 'hex'
      || kind.kind === 'missing')
      return false
    else
      throw new Error(`Unknown file viewer document kind: ${JSON.stringify(kind)}`)
  }
}
