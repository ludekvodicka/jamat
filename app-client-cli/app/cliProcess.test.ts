import { describe, expect, it, vi } from 'vitest'

import { CliProcess } from './cliProcess'

describe('app-client-cli/app/cliProcess', () => {
  it('uses the shell EPIPE exit and rethrows every other stream error', () => {
    const exits: number[] = []
    const exit = ((code: number) => {
      exits.push(code)
      throw new Error('exit')
    }) as (code: number) => never

    expect(() => CliProcess.handleStreamError(
      Object.assign(new Error('pipe'), { code: 'EPIPE' }),
      exit,
    )).toThrow('exit')
    expect(exits).toEqual([141])
    expect(() => CliProcess.handleStreamError(
      Object.assign(new Error('disk'), { code: 'EIO' }),
      vi.fn() as unknown as (code: number) => never,
    )).toThrow('disk')
  })
})
