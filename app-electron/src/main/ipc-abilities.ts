import { homedir } from 'os'
import { registerHandler } from '../shared/typed-ipc'
import { scanAbilities } from '../../../core/abilities/scan.js'
import { manageAbility } from '../../../core/abilities/manage.js'
import { logError } from './logger'
import type { AbilitiesResult, AbilitiesManageRequest, AbilitiesManageResult } from '../../../core/types/abilities.js'

const EMPTY: AbilitiesResult = { skills: [], commands: [], plugins: [], agents: [], mcp: [], instructions: [], warnings: [], homeDir: '' }

/** `abilities:list` (read) + `abilities:manage` (write) for the Claude Abilities tab.
 *  `abilities:manage` is the FIRST write path into ~/.claude — it's a `'rw'` op, reach ['ui','ai']
 *  only (never remote), and all path safety lives in core/abilities/manage.ts. */
export function registerAbilitiesIpc(): void {
  registerHandler('abilities:list', async (): Promise<AbilitiesResult> => {
    try {
      return scanAbilities(homedir())
    } catch (err) {
      logError('abilities:list', `${err}`)
      return { ...EMPTY, homeDir: homedir(), warnings: [String(err)] }
    }
  })

  registerHandler('abilities:manage', async (_event, req: AbilitiesManageRequest): Promise<AbilitiesManageResult> => {
    try {
      return manageAbility(homedir(), req)
    } catch (err) {
      logError('abilities:manage', `${err}`)
      return { ok: false, error: String(err) }
    }
  })
}
