import { describe, expect, it } from 'vitest'
import { DevRestartQuiet } from './devRestartQuiet'

describe('DevRestartQuiet', () => {
  it('waits a minute of quiet when nothing is set', () => {
    expect(DevRestartQuiet.millisecondsOf({})).toBe(60_000)
    expect(DevRestartQuiet.millisecondsOf({ JAMAT_V3_DEV_RESTART_QUIET_SECONDS: ' ' })).toBe(60_000)
  })

  it('takes whole seconds, and 0 rebuilds on every save', () => {
    expect(DevRestartQuiet.millisecondsOf({ JAMAT_V3_DEV_RESTART_QUIET_SECONDS: '15' })).toBe(15_000)
    expect(DevRestartQuiet.millisecondsOf({ JAMAT_V3_DEV_RESTART_QUIET_SECONDS: '0' })).toBe(0)
  })

  it('refuses a value that is not whole seconds in range, naming the variable', () => {
    for (const value of ['1.5', '-1', 'soon', '3601'])
      expect(() => DevRestartQuiet.millisecondsOf({ JAMAT_V3_DEV_RESTART_QUIET_SECONDS: value }))
        .toThrow(/JAMAT_V3_DEV_RESTART_QUIET_SECONDS/)
  })
})
