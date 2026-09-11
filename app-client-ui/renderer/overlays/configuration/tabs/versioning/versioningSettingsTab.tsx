import { useCallback, useRef } from 'react'

import type { ConfigurationTabProps } from '../../configurationTab.types'
import {
  FileChangesSettingsSection,
} from '../fileChanges/fileChangesSettingsSection'
import './versioningSettings.css'
import { DiffToolSection } from './diffToolSection'
import { VersioningModeSection } from './versioningModeSection'
import { CommitReviewSection } from './commitReviewSection'

export function VersioningSettingsTab(props: ConfigurationTabProps): React.JSX.Element {
  const dirty = useRef({ versioning: false, fileChanges: false, diffTool: false, commitReview: false })
  const dirtyChange = useRef(props.onDirtyChange)
  dirtyChange.current = props.onDirtyChange
  const report = useCallback((section: keyof typeof dirty.current, modified: boolean): void => {
    dirty.current = { ...dirty.current, [section]: modified }
    dirtyChange.current(Object.values(dirty.current).some(Boolean))
  }, [])

  return (
    <>
      <VersioningModeSection onDirtyChange={(modified) => report('versioning', modified)} />
      <CommitReviewSection onDirtyChange={(modified) => report('commitReview', modified)} />
      <DiffToolSection onDirtyChange={(modified) => report('diffTool', modified)} />
      <FileChangesSettingsSection onDirtyChange={(modified) => report('fileChanges', modified)} />
    </>
  )
}
