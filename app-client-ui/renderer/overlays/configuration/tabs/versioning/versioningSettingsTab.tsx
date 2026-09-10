import { useCallback, useRef } from 'react'

import type { ConfigurationTabProps } from '../../configurationTab.types'
import {
  FileChangesSettingsSection,
} from '../fileChanges/fileChangesSettingsSection'
import './versioningSettings.css'
import { DiffToolSection } from './diffToolSection'
import { VersioningModeSection } from './versioningModeSection'

export function VersioningSettingsTab(props: ConfigurationTabProps): React.JSX.Element {
  const dirty = useRef({ versioning: false, fileChanges: false, diffTool: false })
  const dirtyChange = useRef(props.onDirtyChange)
  dirtyChange.current = props.onDirtyChange
  const report = useCallback((section: 'versioning' | 'fileChanges' | 'diffTool', modified: boolean): void => {
    dirty.current = { ...dirty.current, [section]: modified }
    dirtyChange.current(dirty.current.versioning || dirty.current.fileChanges || dirty.current.diffTool)
  }, [])

  return (
    <>
      <VersioningModeSection onDirtyChange={(modified) => report('versioning', modified)} />
      <DiffToolSection onDirtyChange={(modified) => report('diffTool', modified)} />
      <FileChangesSettingsSection onDirtyChange={(modified) => report('fileChanges', modified)} />
    </>
  )
}
