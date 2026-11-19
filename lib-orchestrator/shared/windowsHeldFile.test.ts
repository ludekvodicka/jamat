import { describe, expect, it, vi } from 'vitest'

import { WindowsHeldFile } from './windowsHeldFile'

describe('lib-orchestrator/shared/windowsHeldFile', () => {
  const failure = (code: string) => Object.assign(new Error(code), { code })

  it.skipIf(process.platform !== 'win32').each(['EPERM', 'EACCES', 'EBUSY'])('retries a synchronous %s until the holder lets go', (code) => {
    const operation = vi.fn().mockImplementationOnce(() => { throw failure(code) }).mockImplementationOnce(() => { throw failure(code) }).mockReturnValue('done')
    expect(WindowsHeldFile.retriedSync(operation)).toBe('done')
    expect(operation).toHaveBeenCalledTimes(3)
  })

  it.skipIf(process.platform !== 'win32')('retries an asynchronous refusal until the holder lets go', async () => {
    const operation = vi.fn().mockRejectedValueOnce(failure('EPERM')).mockResolvedValue('done')
    await expect(WindowsHeldFile.retried(operation)).resolves.toBe('done')
    expect(operation).toHaveBeenCalledTimes(2)
  })

  it('fails at once on another code', async () => {
    const synchronous = vi.fn(() => { throw failure('ENOENT') })
    expect(() => WindowsHeldFile.retriedSync(synchronous)).toThrow('ENOENT')
    expect(synchronous).toHaveBeenCalledOnce()
    const asynchronous = vi.fn().mockRejectedValue(failure('EIO'))
    await expect(WindowsHeldFile.retried(asynchronous)).rejects.toMatchObject({ code: 'EIO' })
    expect(asynchronous).toHaveBeenCalledOnce()
  })

  it.skipIf(process.platform === 'win32')('fails at once outside Windows, where these codes mean a real permission problem', () => {
    const operation = vi.fn(() => { throw failure('EPERM') })
    expect(() => WindowsHeldFile.retriedSync(operation)).toThrow('EPERM')
    expect(operation).toHaveBeenCalledOnce()
  })
})
