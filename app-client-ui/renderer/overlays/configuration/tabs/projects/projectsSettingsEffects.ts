import type {
  CatalogCategoryDto,
  ProjectsOpResult,
} from '../../../../../../lib-orchestrator/projectManager/projectManagerApi.types'
import type { IpcResult } from '../../../../../shared/appClientUiIpc'
import type { ProjectsSettingsEffect, ProjectsSettingsInput } from './projectsSettingsModel'

export interface ProjectsSettingsPorts {
  dispatch(input: ProjectsSettingsInput): void
}

/**
 * The tab's whole conversation with the main process, and the only file of it that performs I/O.
 *
 * Two unwraps, always in this order: `IpcResult` says whether the channel answered at all, and only
 * then does `ProjectsOpResult` say what the catalog store decided. Folded into one check, a refused
 * save - `catalog-latched` because the file on disk is damaged, `invalid-config` because a root has
 * no name - would read like a broken pipe, and the user would retry the one thing that cannot work.
 * The refusal's own words are what reach the surface; nothing here rewrites them.
 */
export class ProjectsSettingsEffects {
  private static readonly pickTitleConst = 'Choose a projects root'

  static async run(effect: ProjectsSettingsEffect, ports: ProjectsSettingsPorts): Promise<void> {
    if (effect.effect === 'load') return ProjectsSettingsEffects.load(ports)
    else if (effect.effect === 'save') return ProjectsSettingsEffects.save(effect.categories, ports)
    else if (effect.effect === 'pick-directory') return ProjectsSettingsEffects.pick(ports)
    else
      throw new Error(`Unknown projects settings effect: ${JSON.stringify(effect)}`)
  }

  private static async load(ports: ProjectsSettingsPorts): Promise<void> {
    const answer = await window.appClient.projects.getConfig()
    if (!answer.ok)
      return ports.dispatch({ input: 'failed', detail: ProjectsSettingsEffects.silent(answer.error) })
    if (!answer.value.ok)
      return ports.dispatch({
        input: 'failed',
        detail: `${answer.value.code}: ${answer.value.detail}`,
      })
    ports.dispatch({ input: 'loaded', categories: answer.value.value })
  }

  /**
   * Every root goes over, unknown keys inside a category and all: the store replaces the section
   * with what it is handed, so a category key left out here is deleted from the file. What stands
   * beside the section is never sent and never at risk - the store merges into the raw document.
   */
  private static async save(
    categories: readonly CatalogCategoryDto[],
    ports: ProjectsSettingsPorts,
  ): Promise<void> {
    const answer: IpcResult<ProjectsOpResult> = await window.appClient.projects.saveConfig(categories)
    if (!answer.ok)
      return ports.dispatch({ input: 'failed', detail: ProjectsSettingsEffects.silent(answer.error) })
    if (!answer.value.ok)
      return ports.dispatch({
        input: 'saved',
        ok: false,
        detail: `${answer.value.code}: ${answer.value.detail}`,
      })
    ports.dispatch({ input: 'saved', ok: true })
  }

  /** A cancelled picker is an answer, so it dispatches nothing and leaves the buffer as it was. */
  private static async pick(ports: ProjectsSettingsPorts): Promise<void> {
    const answer = await window.appClient.dialog
      .pickDirectory(ProjectsSettingsEffects.pickTitleConst)
    if (!answer.ok)
      return ports.dispatch({ input: 'failed', detail: ProjectsSettingsEffects.silent(answer.error) })
    if (answer.value === null)
      return
    ports.dispatch({ input: 'add', path: answer.value.path })
  }

  /** Said in the words of the transport, so it cannot be mistaken for something the catalog refused. */
  private static silent(error: string): string {
    return `The main process did not answer: ${error}`
  }
}
