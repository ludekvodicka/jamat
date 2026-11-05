import { describe, expect, it } from 'vitest'
import { TokensSectionModel } from './tokensSectionModel'

describe('TokensSectionModel', () => {
  it('totals each non-overlapping counter once', () => {
    expect(TokensSectionModel.total({ input: 70, cacheRead: 30, output: 20, cacheWrite: 0 })).toBe(120)
  })
  it('sums the counters of every row', () => {
    expect(TokensSectionModel.sum([{ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 }]))
      .toEqual({ input: 11, output: 22, cacheRead: 33, cacheWrite: 44 })
  })
})
