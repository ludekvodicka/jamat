import { describe, expect, it } from 'vitest'

import type { PerfReading } from '../../shared/perfSample'
import { PerfStatusModel } from './perfStatusItem'

describe('app-client-ui/renderer/statusBar/perfStatusItem', () => {
  function readingOf(overrides: Partial<PerfReading> = {}): PerfReading {
    return {
      rendererLagMs: 3,
      mainRoundTripMs: 8,
      mainLoopDelayP95Ms: 2,
      mainLoopDelayMaxMs: 5,
      hostCallMaxMs: 12,
      echoMaxMs: 40,
      mainWorst: null,
      ...overrides,
    }
  }

  it('draws one number per place a keystroke can be held up', () => {
    expect(PerfStatusModel.partsOf(readingOf()).map((part) => `${part.label} ${part.value}`))
      .toEqual(['R 3', 'M 8', 'H 12', 'echo 40'])
  })

  /**
   * The round trip is what a keystroke actually waits; the loop delay is why. The worse of the two
   * is drawn, so a queue in front of the IPC and a blocked loop both show.
   */
  it('takes the worse of the round trip and the loop delay for the main process', () => {
    expect(PerfStatusModel.partsOf(readingOf({ mainRoundTripMs: 8, mainLoopDelayMaxMs: 240 }))
      .find((part) => part.label === 'M')).toEqual({ label: 'M', value: '240', tone: 'bad' })
  })

  it('colours each number by what somebody would notice', () => {
    const parts = PerfStatusModel.partsOf(readingOf({
      rendererLagMs: 10, mainRoundTripMs: 120, hostCallMaxMs: 900, echoMaxMs: 20,
    }))
    expect(parts.map((part) => part.tone)).toEqual(['good', 'slow', 'bad', 'good'])
  })

  // A window nobody typed in is not a window somebody typed in and got an instant answer.
  it('draws a dash where nothing was measured rather than a zero', () => {
    const parts = PerfStatusModel.partsOf(readingOf({ hostCallMaxMs: null, echoMaxMs: null }))
    expect(parts.map((part) => part.value)).toEqual(['3', '8', '-', '-'])
  })

  /**
   * A red M is a symptom; the name behind it is the address. It joins the bar only while the main
   * process is the one being waited on, because the rest of the time it is noise.
   */
  it('names what held the main process, but only while the main process is slow', () => {
    const slow = readingOf({
      mainRoundTripMs: 2_400,
      mainWorst: { label: 'fileChanges:working-tree', milliseconds: 2_350 },
    })
    expect(PerfStatusModel.partsOf(slow).at(-1))
      .toEqual({ label: '<', value: 'fileChanges:working-tree', tone: 'bad' })
    expect(PerfStatusModel.titleOf(slow)).toContain('fileChanges:working-tree, 2350 ms')

    const quick = readingOf({ mainWorst: { label: 'tabs:list', milliseconds: 9 } })
    expect(PerfStatusModel.partsOf(quick).map((part) => part.label)).toEqual(['R', 'M', 'H', 'echo'])
  })

  // Nothing named while the loop was held says the block is somewhere no door of ours covers.
  it('says so when nothing passed through a door it watches', () => {
    expect(PerfStatusModel.titleOf(readingOf({ mainWorst: null })))
      .toContain('nothing over 5 ms')
  })

  it('says what each number is in one place a person can hover', () => {
    const title = PerfStatusModel.titleOf(readingOf())
    expect(title).toContain('this window')
    expect(title).toContain('every keystroke')
    expect(title).toContain('the agent included')
  })
})
