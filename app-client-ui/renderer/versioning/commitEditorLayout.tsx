import { useEffect, useRef, useState } from 'react'
import { VersioningSettings } from '../../shared/versioningSettings'
import type { CommitPanePorts } from './commitPanePorts'

export function CommitEditorLayout(props: {
  files: React.ReactNode
  message: React.ReactNode
  settings: Pick<CommitPanePorts['versioning'], 'getSettings' | 'saveSettings'>
  reportError: CommitPanePorts['reportError']
}): React.JSX.Element {
  const container = useRef<HTMLDivElement>(null)
  const drag = useRef<{ pointerId: number; startY: number; ratio: number; height: number } | null>(null)
  const [ratio, setRatio] = useState(VersioningSettings.defaultCommitSplitRatioConst)
  const currentRatio = useRef(ratio)
  const resized = useRef(false)
  const minRatio = VersioningSettings.minCommitSplitRatioConst
  const maxRatio = VersioningSettings.maxCommitSplitRatioConst
  useEffect(() => {
    let disposed = false
    void props.settings.getSettings().then((answer) => {
      if (disposed || resized.current) return
      if (!answer.ok) { props.reportError(answer.error); return }
      const stored = answer.value.commitSplitRatio
      if (VersioningSettings.isCommitSplitRatio(stored)) {
        currentRatio.current = stored
        setRatio(stored)
      }
    }).catch((error: unknown) => { if (!disposed) props.reportError(String(error)) })
    return () => { disposed = true }
  }, [props.settings, props.reportError])
  const resize = (value: number): void => {
    resized.current = true
    currentRatio.current = Math.max(minRatio, Math.min(maxRatio, value))
    setRatio(currentRatio.current)
  }
  const save = (): void => {
    void props.settings.saveSettings({ ...VersioningSettings.defaultValue(), commitSplitRatio: currentRatio.current }, 'commitSplitRatio')
      .then((answer) => {
        if (!answer.ok) props.reportError(answer.error)
        else if (!answer.value.ok) props.reportError(answer.value.detail)
      }).catch((error: unknown) => props.reportError(String(error)))
  }
  const finishDrag = (): void => {
    if (drag.current === null) return
    drag.current = null
    save()
  }

  return <div className="commit-editor" ref={container}>
    {props.files !== null && <>
      <div className="commit-editor-files" style={{ flexGrow: ratio }}>{props.files}</div>
      <div className="commit-editor-splitter" role="separator" aria-orientation="horizontal"
        aria-label="Resize file list and commit message" tabIndex={0}
        aria-valuemin={minRatio * 100} aria-valuemax={maxRatio * 100} aria-valuenow={Math.round(ratio * 100)}
        aria-valuetext={`File list ${Math.round(ratio * 100)}%, commit message ${Math.round((1 - ratio) * 100)}%`}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          const height = (container.current?.getBoundingClientRect().height ?? 0) - event.currentTarget.getBoundingClientRect().height
          if (height <= 0) return
          event.preventDefault()
          event.currentTarget.focus()
          event.currentTarget.setPointerCapture(event.pointerId)
          resized.current = true
          drag.current = { pointerId: event.pointerId, startY: event.clientY, ratio, height }
        }}
        onPointerMove={(event) => {
          const active = drag.current
          if (active === null || active.pointerId !== event.pointerId) return
          resize(active.ratio + (event.clientY - active.startY) / active.height)
        }}
        onPointerUp={(event) => {
          if (drag.current?.pointerId !== event.pointerId) return
          finishDrag()
          event.currentTarget.releasePointerCapture(event.pointerId)
        }}
        onPointerCancel={finishDrag}
        onLostPointerCapture={finishDrag}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
          event.preventDefault()
          event.stopPropagation()
          resize(ratio + (event.key === 'ArrowUp' ? -0.05 : 0.05))
          save()
        }} />
    </>}
    <div className="commit-editor-message" style={{ flexGrow: props.files === null ? 1 : 1 - ratio }}>{props.message}</div>
  </div>
}
