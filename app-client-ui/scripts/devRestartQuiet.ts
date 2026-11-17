/**
 * How long `pnpm dev` waits after the last saved main-process or preload input before it rebuilds
 * and restarts Electron. Rollup's `buildDelay` starts its timer again on every change, so a run of
 * saves, such as an agent editing one file after another, restarts Jamat once after the edits went
 * quiet instead of every few seconds. The renderer keeps its own hot update and never waits.
 */
export class DevRestartQuiet {
  static readonly variableConst = 'JAMAT_V3_DEV_RESTART_QUIET_SECONDS'
  static readonly defaultSecondsConst = 60
  static readonly maxSecondsConst = 3_600

  /** 0 rebuilds on every save, as before. A value that is not whole seconds stops `pnpm dev` with its name. */
  static millisecondsOf(env: Readonly<Record<string, string | undefined>>): number {
    const raw = env[DevRestartQuiet.variableConst]
    if (raw === undefined || raw.trim() === '') return DevRestartQuiet.defaultSecondsConst * 1_000
    const seconds = Number(raw)
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > DevRestartQuiet.maxSecondsConst)
      throw new Error(`${DevRestartQuiet.variableConst} must be whole seconds from 0 to ${DevRestartQuiet.maxSecondsConst}, not ${JSON.stringify(raw)}`)
    return seconds * 1_000
  }
}
