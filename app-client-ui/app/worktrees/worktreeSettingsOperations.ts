import { z } from 'zod'

import type { ConfigStore } from '../../../lib-orchestrator/configStore/configStore'
import { WorktreeConfig } from '../../../lib-orchestrator/projectSetup/worktreeConfig'
import { RemoteControlOutcome } from '../../../lib-orchestrator/remoteControl/remoteControlOutcome'
import type { RemoteControlRegistry } from '../../../lib-orchestrator/remoteControl/remoteControlRegistry'
import { RemoteControlZod } from '../../../lib-orchestrator/remoteControl/remoteControlSchemas'
import type { RemoteControlStepResult } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type { AppOperationMap } from '../../shared/appOperationMap'
import type {
  ProjectSetupRead,
  ProjectSetupWrite,
  WorktreeSettingsSaveResult,
  WorktreeSettingsValue,
} from '../../shared/worktreeSettings'
import { WorktreeSettingsSection } from './worktreeSettingsSection'

/** The platform tier of worktree setup, and one project's own `.worktree.json`. */
export class WorktreeSettingsOperations {
  constructor(
    private readonly configStore: ConfigStore,
    private readonly authorizeProjectPath: (candidate: unknown) => Promise<string | null>,
  ) {}

  register(registry: Pick<RemoteControlRegistry, 'registrar'>): void {
    const op = registry.registrar<AppOperationMap>()
    op('worktreeSettings.get', {
      kind: 'read',
      description: 'The worktrees section: the setup commands of every project kind.',
      input: z.strictObject({}),
      run: async () => ({ ok: true, value: this.configStore.readSection(WorktreeSettingsSection.spec) }),
    })
    op('worktreeSettings.save', {
      kind: 'write',
      description: 'Replace the worktrees section; the section refuses a value it cannot store, naming the field.',
      input: z.strictObject({ value: RemoteControlZod.ownedObject<WorktreeSettingsValue>() }),
      run: async (body) => RemoteControlOutcome.of(this.save(body.value)),
    })
    op('projectSetup.get', {
      kind: 'read',
      description: "A catalog project's own setup commands from its `.worktree.json`; null when it names none.",
      input: z.strictObject({ projectPath: RemoteControlZod.text(RemoteControlZod.pathLengthConst) }),
      run: async (body) => WorktreeSettingsOperations.problemOutcome(await this.projectSetup(body.projectPath),
        (read) => ({ setup: read.setup })),
    })
    op('projectSetup.save', {
      kind: 'write',
      description: "Write a catalog project's setup commands into its `.worktree.json`.",
      input: z.strictObject({
        projectPath: RemoteControlZod.text(RemoteControlZod.pathLengthConst),
        setup: z.array(RemoteControlZod.string(4_096), { error: 'setup must be a list of commands' }),
      }),
      run: async (body) => WorktreeSettingsOperations.problemOutcome(
        await this.saveProjectSetup(body.projectPath, body.setup), () => ({})),
    })
  }

  /** Two answers collapse into one here: no file and a file with no `setup` key both mean null. */
  private async projectSetup(projectPath: unknown): Promise<ProjectSetupRead> {
    const authorized = await this.authorizeProjectPath(projectPath)
    if (authorized === null) return WorktreeSettingsOperations.projectRefusal()
    const read = await WorktreeConfig.read(authorized)
    if (!read.ok) return { ok: false, problem: read.problem }
    return { ok: true, setup: read.value?.setup ?? null }
  }

  private async saveProjectSetup(projectPath: unknown, setup: string[]): Promise<ProjectSetupWrite> {
    const authorized = await this.authorizeProjectPath(projectPath)
    if (authorized === null) return WorktreeSettingsOperations.projectRefusal()
    return WorktreeConfig.save(authorized, setup)
  }

  private static projectRefusal(): { ok: false; problem: string } {
    return { ok: false, problem: 'The selected project is no longer in the AppJamatV3 catalog' }
  }

  /** A project file refusal carries a sentence and no code; `project-setup` names where it came from. */
  private static problemOutcome<T extends { ok: true }, V>(
    result: T | { ok: false; problem: string },
    valueOf: (result: T) => V,
  ): RemoteControlStepResult<V> {
    if (result.ok) return { ok: true, value: valueOf(result as T) }
    return { ok: false, error: { code: 'operation-failed', detail: result.problem, data: { sourceCode: 'project-setup' } } }
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
