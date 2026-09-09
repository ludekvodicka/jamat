import type {
  FileChangesVcsId,
} from '../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'

/**
 * Which VCS a session prefers where both are there. The wire's own union rather than a third copy of
 * `git | svn`: the IPC service assigns one to the other, and that compiled only because the two
 * happened to match.
 */
export type FileChangesPrimaryVcs = FileChangesVcsId

export interface FileChangesSettingsValue {
  primaryVcs: FileChangesPrimaryVcs
}

export type FileChangesSettingsSaveResult =
  | { ok: true }
  | { ok: false; code: 'config-latched' | 'invalid-section'; detail: string }

export class FileChangesSettings {
  static readonly primaryVcsOptionsConst: readonly FileChangesPrimaryVcs[] = ['git', 'svn']
  static readonly defaultPrimaryVcsConst: FileChangesPrimaryVcs = 'git'

  static defaultValue(): FileChangesSettingsValue {
    return { primaryVcs: FileChangesSettings.defaultPrimaryVcsConst }
  }

  static coerce(value: unknown, report: (message: string) => void): FileChangesSettingsValue {
    if (value === undefined) return FileChangesSettings.defaultValue()
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      report('The fileChanges section of config.json is not an object; reading primaryVcs as git')
      return FileChangesSettings.defaultValue()
    }
    const document = value as Partial<Record<keyof FileChangesSettingsValue, unknown>>
    if (FileChangesSettings.isPrimaryVcs(document.primaryVcs))
      return { ...document, primaryVcs: document.primaryVcs }
    if (document.primaryVcs !== undefined)
      report(
        'The fileChanges section of config.json has an unusable primaryVcs '
        + `(${JSON.stringify(document.primaryVcs)}); reading it as git`,
      )
    return { ...document, primaryVcs: FileChangesSettings.defaultPrimaryVcsConst }
  }

  static isValid(value: unknown): value is FileChangesSettingsValue {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const document = value as Partial<Record<keyof FileChangesSettingsValue, unknown>>
    return FileChangesSettings.isPrimaryVcs(document.primaryVcs)
  }

  private static isPrimaryVcs(value: unknown): value is FileChangesPrimaryVcs {
    return typeof value === 'string'
      && (FileChangesSettings.primaryVcsOptionsConst as readonly string[]).includes(value)
  }
}
