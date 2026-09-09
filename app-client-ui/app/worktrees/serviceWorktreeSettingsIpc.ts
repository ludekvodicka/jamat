import type { ConfigStore } from '../../../lib-orchestrator/configStore/configStore'
import { WorktreeConfig } from '../../../lib-orchestrator/projectSetup/worktreeConfig'
import type {
  ProjectSetupRead,
  ProjectSetupWrite,
  WorktreeSettingsSaveResult,
  WorktreeSettingsValue,
} from '../../shared/worktreeSettings'
import { ServiceIpcBase } from '../shared/serviceIpcBase'
import { WorktreeSettingsSection } from './worktreeSettingsSection'

/**
 * How this machine installs a worktree's dependencies, over one section of `config.json`.
 *
 * It is a second settings service beside `ServiceVersioningSettingsIpc` rather than a group inside
 * it, because the two own different sections and a service that saved both would report one outcome
 * for two writes.
 *
 * The project's own tier goes through `WorktreeConfig` directly and not through a
 * `ProjectSetupManager`: that class is built by and owned by the `SessionManager`, and editing a
 * file in a checkout has nothing to do with a session. `read` and `save` are static and own no
 * state, which is what makes reaching for the manager unnecessary rather than merely awkward.
 */
export class ServiceWorktreeSettingsIpc extends ServiceIpcBase<
  typeof ServiceWorktreeSettingsIpc.channelsConst
> {
  static readonly channelsConst = {
    'worktrees:settings-get': true,
    'worktrees:settings-save': true,
    'worktrees:project-setup-get': true,
    'worktrees:project-setup-save': true,
  } as const

  constructor(
    private readonly configStore: ConfigStore,
    private readonly authorizeProjectPath: (candidate: unknown) => Promise<string | null>,
  ) {
    super()
  }

  initialize(): void {
    this.register(
      'worktrees:settings-get',
      () => this.configStore.readSection(WorktreeSettingsSection.spec),
    )
    this.register('worktrees:settings-save', (_event, value) => this.save(value))
    this.register(
      'worktrees:project-setup-get',
      (_event, projectPath) => this.projectSetup(projectPath),
    )
    this.register(
      'worktrees:project-setup-save',
      // Annotated so the wire type and the custodian's own answer cannot drift apart silently.
      (_event, projectPath, setup): Promise<ProjectSetupWrite> =>
        this.saveProjectSetup(projectPath, setup),
    )
    this.assertComplete(ServiceWorktreeSettingsIpc.channelsConst)
  }

  /** Two answers collapse into one here: no file and a file with no `setup` key both mean null. */
  private async projectSetup(projectPath: unknown): Promise<ProjectSetupRead> {
    const authorized = await this.authorizeProjectPath(projectPath)
    if (authorized === null) return ServiceWorktreeSettingsIpc.projectRefusal()
    const read = await WorktreeConfig.read(authorized)
    if (!read.ok) return { ok: false, problem: read.problem }
    return { ok: true, setup: read.value?.setup ?? null }
  }

  private async saveProjectSetup(projectPath: unknown, setup: string[]): Promise<ProjectSetupWrite> {
    const authorized = await this.authorizeProjectPath(projectPath)
    if (authorized === null) return ServiceWorktreeSettingsIpc.projectRefusal()
    return WorktreeConfig.save(authorized, setup)
  }

  private static projectRefusal(): { ok: false; problem: string } {
    return { ok: false, problem: 'The selected project is no longer in the AppJamatV3 catalog' }
  }

  private save(value: WorktreeSettingsValue): WorktreeSettingsSaveResult {
    const saved = this.configStore.saveSection(WorktreeSettingsSection.spec, value)
    if (saved.ok) return saved
    else if (saved.code === 'config-latched' || saved.code === 'invalid-section')
      return { ok: false, code: saved.code, detail: saved.detail }
    else
      throw new Error(`Unexpected worktrees section save result: ${JSON.stringify(saved)}`)
  }
}
