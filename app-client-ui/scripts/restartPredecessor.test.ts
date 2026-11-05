import { afterEach, describe, expect, it, vi } from 'vitest'
import { waitForRestartPredecessor } from './restartPredecessor'

describe('waitForRestartPredecessor', () => {
  afterEach(() => { delete process.env.JAMAT_V3_RESTART_PARENT_PID; vi.restoreAllMocks() })

  it('consumes the private value and waits for the predecessor to exit', async () => {
    process.env.JAMAT_V3_RESTART_PARENT_PID = '123456'
    const kill = vi.spyOn(process, 'kill').mockReturnValueOnce(true)
      .mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) })
    const waiting = waitForRestartPredecessor()
    expect(process.env.JAMAT_V3_RESTART_PARENT_PID).toBeUndefined()
    await waiting
    expect(kill).toHaveBeenCalledTimes(2)
    expect(kill).toHaveBeenCalledWith(123456, 0)
    await waitForRestartPredecessor()
    expect(kill).toHaveBeenCalledTimes(2)
  })

  it('refuses an invalid PID, a live predecessor after 30 seconds and unprovable liveness', async () => {
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    for (const value of ['0', '-1', '12x', '1e3', '2147483648', String(process.pid)]) {
      process.env.JAMAT_V3_RESTART_PARENT_PID = value
      await expect(waitForRestartPredecessor()).rejects.toThrow('Invalid restart predecessor PID')
      expect(process.env.JAMAT_V3_RESTART_PARENT_PID).toBeUndefined()
    }
    expect(kill).not.toHaveBeenCalled()
    process.env.JAMAT_V3_RESTART_PARENT_PID = '123456'
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(30_000)
    await expect(waitForRestartPredecessor()).rejects.toThrow('did not exit within 30 seconds')
    process.env.JAMAT_V3_RESTART_PARENT_PID = '123456'
    kill.mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) })
    await expect(waitForRestartPredecessor()).rejects.toThrow('denied')
  })
})
