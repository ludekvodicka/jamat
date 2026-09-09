import {
  SettingsCardEffects,
  type SettingsCardPorts,
} from '../../settingsCard'
import type {
  WorktreesSettingsEffect,
  WorktreesSettingsInput,
} from './worktreesSettingsModel'

export type WorktreesSettingsPorts = SettingsCardPorts<WorktreesSettingsInput>

/** Which channels this card reads and writes; the two calls around them are `SettingsCardEffects`'. */
export class WorktreesSettingsEffects {
  static async run(
    effect: WorktreesSettingsEffect,
    ports: WorktreesSettingsPorts,
  ): Promise<void> {
    if (effect.effect === 'load')
      return SettingsCardEffects.load(
        () => window.appClient.worktrees.getSettings(),
        ports,
        {
          loaded: (value) => ({ input: 'loaded' as const, value }),
          failed: (detail) => ({ input: 'failed' as const, detail }),
        },
      )
    else if (effect.effect === 'save')
      return SettingsCardEffects.save(
        effect.value,
        (value) => window.appClient.worktrees.saveSettings(value),
        ports,
        {
          failed: (detail) => ({ input: 'failed' as const, detail }),
          saved: (ok, detail) => ({ input: 'saved' as const, ok, detail }),
        },
      )
    else if (effect.effect === 'project-load') {
      const answer = await window.appClient.worktrees.getProjectSetup(effect.projectPath)
      if (!answer.ok)
        return ports.dispatch({
          input: 'project-unreadable',
          problem: `The main process did not answer: ${answer.error}`,
        })
      if (!answer.value.ok)
        return ports.dispatch({ input: 'project-unreadable', problem: answer.value.problem })
      return ports.dispatch({ input: 'project-loaded', setup: answer.value.setup })
    }
    else if (effect.effect === 'project-save') {
      const answer = await window.appClient.worktrees
        .saveProjectSetup(effect.projectPath, effect.setup)
      if (!answer.ok)
        return ports.dispatch({
          input: 'project-saved',
          ok: false,
          problem: `The main process did not answer: ${answer.error}`,
        })
      if (!answer.value.ok)
        return ports.dispatch({
          input: 'project-saved',
          ok: false,
          problem: answer.value.problem,
        })
      return ports.dispatch({ input: 'project-saved', ok: true })
    }
    else
      throw new Error(`Unknown worktrees settings effect: ${JSON.stringify(effect)}`)
  }
}
