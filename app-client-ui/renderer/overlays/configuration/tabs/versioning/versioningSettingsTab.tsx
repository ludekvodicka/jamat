import { useCallback, useRef } from 'react'

import type { ConfigurationTabProps } from '../../configurationTab.types'
import {
  FileChangesSettingsSection,
} from '../fileChanges/fileChangesSettingsSection'
import './versioningSettings.css'
import { VersioningModeSection } from './versioningModeSection'

/**
 * Everything about version control in one place: where AI work is written, and which VCS the file
 * surfaces read when a directory has both. They were two tabs until 2026-08-31, and reading either
 * one meant knowing the other existed - "Checkpoints" and "SVN" are one answer about one project,
 * given in two screens under two names.
 *
 * **Two sections, two Save buttons, on purpose.** Each writes its own key of `config.json` through
 * its own writer, so a single Save on the frame would report one outcome for two writes - which is
 * why the settings frame has never had one. What is merged here is the SUBJECT, not the writers.
 */
export function VersioningSettingsTab(props: ConfigurationTabProps): React.JSX.Element {
  /*
   * One dirty answer out of two, because the window asks one question before it lets the tab go.
   * Held per section and OR-ed: a tab that forwarded whichever section spoke last would go clean the
   * moment the other one saved, with unsaved work still on screen above it.
   */
  const dirty = useRef({ versioning: false, fileChanges: false })
  const dirtyChange = useRef(props.onDirtyChange)
  dirtyChange.current = props.onDirtyChange
  const report = useCallback((section: 'versioning' | 'fileChanges', modified: boolean): void => {
    dirty.current = { ...dirty.current, [section]: modified }
    dirtyChange.current(dirty.current.versioning || dirty.current.fileChanges)
  }, [])

  return (
    <>
      <VersioningModeSection onDirtyChange={(modified) => report('versioning', modified)} />
      <FileChangesSettingsSection onDirtyChange={(modified) => report('fileChanges', modified)} />
    </>
  )
}
