import { setTimeout } from 'node:timers/promises'
import { ErrnoCode } from '../../lib-orchestrator/shared/errnoCode'

export async function waitForRestartPredecessor(): Promise<void> {
  const value = process.env.JAMAT_V3_RESTART_PARENT_PID
  delete process.env.JAMAT_V3_RESTART_PARENT_PID
  if (value === undefined) return
  const pid = Number(value)
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(pid) || pid > 2_147_483_647 || pid === process.pid)
    throw new Error('Invalid restart predecessor PID')
  const deadline = performance.now() + 30_000
  for (;;) {
    try { process.kill(pid, 0) }
    catch (error) {
      if (ErrnoCode.of(error) === 'ESRCH') return
      throw error
    }
    if (performance.now() >= deadline) throw new Error('Restart predecessor did not exit within 30 seconds')
    await setTimeout(100)
  }
}
