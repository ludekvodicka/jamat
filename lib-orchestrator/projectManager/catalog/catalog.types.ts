import type { AfterCreateHook, VirtualFolderDef } from '../projectManagerApi.types'

/**
 * A category as the rest of the library consumes it: lookup sets instead of arrays, and the
 * comparable form of the root computed once. `path` stays exactly as the config file spells it.
 */
export interface RuntimeCategory {
  id: string
  label: string
  path: string
  comparablePath: string
  hiddenFolders: ReadonlySet<string>
  flattenFolders: ReadonlySet<string>
  virtualFolders: readonly VirtualFolderDef[]
  afterCreate: AfterCreateHook | null
}

/** The `{ id, label, path }` triple the sessions tree consumes; deliberately no more than that. */
export interface CategorySummary {
  id: string
  label: string
  path: string
}
