import { describe, expect, it } from 'vitest'
import { StatsProgressStreamParser } from './statsProgressStreamParser'

describe('StatsProgressStreamParser', () => {
  it('frames chunk-split progress and preserves diagnostics', () => {
    const parser = new StatsProgressStreamParser()
    expect(parser.push('__JAMAT_STATS_PROGRESS__:{"phase":"claude')).toEqual([])
    expect(parser.push('Check","current":3,"total":7}\r\nordinary output\n')).toEqual([
      { kind: 'progress', progress: { phase: 'claudeCheck', current: 3, total: 7 } },
      { kind: 'diagnostic', line: 'ordinary output' },
    ])
  })

  it('treats malformed or unknown progress as diagnostics and flushes a final line', () => {
    const parser = new StatsProgressStreamParser()
    const malformed = '__JAMAT_STATS_PROGRESS__:{broken}'
    const unknown = '__JAMAT_STATS_PROGRESS__:{"phase":"future"}'
    expect(parser.push(`${malformed}\n${unknown}`)).toEqual([{ kind: 'diagnostic', line: malformed }])
    expect(parser.finish()).toEqual([{ kind: 'diagnostic', line: unknown }])
  })
})
