import { describe, expect, it, vi } from 'vitest'

import { AppClientUiReport } from './appClientUiReport'

describe('app-client-ui/shared/appClientUiReport', () => {
  // The prefix is what a person filters the console by. It was written at forty-eight sites, so it
  // is pinned here rather than at each of them.
  it('writes the package prefix in front of the message', () => {
    const written: unknown[][] = []
    const sink = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      written.push(args)
    })

    AppClientUiReport.error('layout not saved: the store is latched')

    expect(written).toEqual([['[app-client-ui] layout not saved: the store is latched']])
    sink.mockRestore()
  })
})
