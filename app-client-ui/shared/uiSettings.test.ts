import { describe, expect, it } from 'vitest'

import { UiSettings } from './uiSettings'

describe('app-client-ui/shared/uiSettings', () => {
  /** Collects what the section owner would have told the user, so every fallback is proved loud. */
  function reported(): { messages: string[]; report: (message: string) => void } {
    const messages: string[] = []
    return { messages, report: (message) => messages.push(message) }
  }

  it('reads 100 % for every scale and speed, and today\'s palette, when nothing is stored', () => {
    expect(UiSettings.defaultValue()).toEqual({
      fontScalePercent: 100,
      fileViewerFontScalePercent: 100,
      terminalFontScalePercent: 100,
      terminalTheme: 'original',
      scrollSpeedPercent: 100,
      terminalScrollSpeedPercent: 100,
    })
  })

  // The key being absent is the first run of every machine, not damage worth a message.
  it('says nothing about a section that is simply not there', () => {
    const { messages, report } = reported()
    expect(UiSettings.coerce(undefined, report)).toEqual(UiSettings.defaultValue())
    expect(messages).toEqual([])
  })

  it('coerces anything that is not an object to the defaults, and says so', () => {
    for (const value of [null, 'ui', 42, [], true]) {
      const { messages, report } = reported()
      expect(UiSettings.coerce(value, report)).toEqual(UiSettings.defaultValue())
      expect(messages).toHaveLength(1)
    }
  })

  it('keeps a usable field while snapping the one beside it', () => {
    const { messages, report } = reported()
    const value = UiSettings.coerce(
      { fontScalePercent: 200, terminalFontScalePercent: 90 },
      report,
    )
    expect(value).toEqual({
      fontScalePercent: 150,
      fileViewerFontScalePercent: 100,
      terminalFontScalePercent: 90,
      terminalTheme: 'original',
      scrollSpeedPercent: 100,
      terminalScrollSpeedPercent: 100,
    })
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('fontScalePercent')
  })

  // The file is hand-edited, and someone who typed 137 asked for a bigger font, not for the size
  // they already had. A number carries that intent onto the grid; anything else carries none.
  it('snaps a hand-edited percentage onto the step and into the range', () => {
    for (const [written, read] of [[112, 110], [137, 135], [200, 150], [10, 70]] as const) {
      const { messages, report } = reported()
      const value = UiSettings.coerce(
        {
          fontScalePercent: written,
          fileViewerFontScalePercent: written,
          terminalFontScalePercent: written,
        },
        report,
      )
      expect(value).toEqual({
        fontScalePercent: read,
        fileViewerFontScalePercent: read,
        terminalFontScalePercent: read,
        terminalTheme: 'original',
        scrollSpeedPercent: 100,
        terminalScrollSpeedPercent: 100,
      })
      expect(messages).toHaveLength(3)
    }
  })

  it('reads a percentage that is not a number as the default', () => {
    for (const percent of ['big', Number.NaN, null]) {
      const { messages, report } = reported()
      const value = UiSettings.coerce(
        {
          fontScalePercent: percent,
          fileViewerFontScalePercent: percent,
          terminalFontScalePercent: percent,
        },
        report,
      )
      expect(value).toEqual(UiSettings.defaultValue())
      expect(messages).toHaveLength(3)
    }
  })

  it('keeps a section it can use exactly as it found it', () => {
    const { messages, report } = reported()
    const stored = {
      fontScalePercent: 115,
      fileViewerFontScalePercent: 130,
      terminalFontScalePercent: 70,
      terminalTheme: 'soft',
      scrollSpeedPercent: 250,
      terminalScrollSpeedPercent: 50,
    }
    expect(UiSettings.coerce(stored, report)).toEqual(stored)
    expect(messages).toEqual([])
  })

  // A file written before this field existed is the ordinary case, not damage: every machine that
  // ever saved a font scale has one, and none of them asked for a palette.
  it('says nothing about a theme that is simply not there', () => {
    const { messages, report } = reported()

    const value = UiSettings.coerce({ fontScalePercent: 100, terminalFontScalePercent: 100 }, report)

    expect(value.terminalTheme).toBe('original')
    expect(messages).toEqual([])
  })

  // The same case two fields later, and the reason the scroll speeds default to the speed the
  // window already had: every section ever saved was written before they existed.
  it('reads absent scroll speeds as 100 %, and says nothing', () => {
    const { messages, report } = reported()

    const value = UiSettings.coerce(
      { fontScalePercent: 115, terminalFontScalePercent: 115, terminalTheme: 'soft' },
      report,
    )

    expect(value.scrollSpeedPercent).toBe(100)
    expect(value.terminalScrollSpeedPercent).toBe(100)
    expect(messages).toEqual([])
  })

  // A speed is snapped onto ITS own grid, which is not the font one: 110 is a font scale somebody
  // could have typed and a scroll speed nobody can have, so it lands on the nearest quarter.
  it('snaps a hand-edited scroll speed onto the coarser step of its own range', () => {
    const { messages, report } = reported()

    const value = UiSettings.coerce(
      { scrollSpeedPercent: 110, terminalScrollSpeedPercent: 900 },
      report,
    )

    expect(value.scrollSpeedPercent).toBe(100)
    expect(value.terminalScrollSpeedPercent).toBe(400)
    expect(messages).toHaveLength(2)
    expect(messages[0]).toContain('scrollSpeedPercent')
  })

  // The same case one field later: every machine that has ever saved this section wrote it before
  // the file viewer had a size of its own, so the absent field is the ordinary read, not damage.
  it('reads a file viewer scale that is simply not there as 100 %, and says nothing', () => {
    const { messages, report } = reported()

    const value = UiSettings.coerce(
      { fontScalePercent: 115, terminalFontScalePercent: 115, terminalTheme: 'soft' },
      report,
    )

    expect(value.fileViewerFontScalePercent).toBe(100)
    expect(messages).toEqual([])
  })

  // There is nothing to snap a name onto, so nothing of what was typed survives - which is exactly
  // why it is said out loud rather than swallowed.
  it('reads a theme it does not know as the default, and says so', () => {
    for (const theme of ['powershell', 'VSCodeDark', '', 7, null, {}]) {
      const { messages, report } = reported()

      const value = UiSettings.coerce(
        {
          fontScalePercent: 100,
          fileViewerFontScalePercent: 100,
          terminalFontScalePercent: 100,
          terminalTheme: theme,
        },
        report,
      )

      expect(value.terminalTheme).toBe('original')
      expect(messages).toHaveLength(1)
      expect(messages[0]).toContain('terminalTheme')
    }
  })

  it('keeps every name it does know', () => {
    for (const theme of UiSettings.terminalThemesConst) {
      const { messages, report } = reported()

      const value = UiSettings.coerceTerminalTheme(theme, report)

      expect(value).toBe(theme)
      expect(messages).toEqual([])
    }
  })

  /**
   * The file says of itself that keys this build does not know are preserved on save, and a save is
   * a read followed by a write of what was read: a section rebuilt from the two fields below would
   * delete the note the moment a slider moved, without anyone being asked.
   */
  it('carries a key it does not know through the read and back into the write', () => {
    const { messages, report } = reported()
    const stored = {
      fontScalePercent: 115,
      fileViewerFontScalePercent: 130,
      terminalFontScalePercent: 70,
      terminalTheme: 'vscodeDark',
      scrollSpeedPercent: 175,
      terminalScrollSpeedPercent: 300,
      _note: 'hand written',
    }

    const value = UiSettings.coerce(stored, report)

    expect(value).toEqual(stored)
    expect(UiSettings.isValid(value)).toBe(true)
    expect(messages).toEqual([])
  })

  // Snapping is what makes this its own case: the two fields are replaced on the way out, and the
  // key beside them must not be replaced with them.
  it('keeps that key while it snaps the fields it does know', () => {
    const { report } = reported()

    const value = UiSettings.coerce(
      { fontScalePercent: 112, terminalFontScalePercent: 'big', _note: 'hand written' },
      report,
    )

    expect(value).toEqual({
      fontScalePercent: 110,
      fileViewerFontScalePercent: 100,
      terminalFontScalePercent: 100,
      terminalTheme: 'original',
      scrollSpeedPercent: 100,
      terminalScrollSpeedPercent: 100,
      _note: 'hand written',
    })
  })

  /** A whole section at one font percentage, since `isValid` answers about every field at once. */
  function section(percent: number, terminalTheme: unknown = 'original'): unknown {
    return {
      fontScalePercent: percent,
      fileViewerFontScalePercent: percent,
      terminalFontScalePercent: percent,
      terminalTheme,
      scrollSpeedPercent: 100,
      terminalScrollSpeedPercent: 100,
    }
  }

  it('validates the shape field by field, never as text', () => {
    expect(UiSettings.isValid(UiSettings.defaultValue())).toBe(true)
    expect(UiSettings.isValid({
      terminalTheme: 'soft',
      terminalFontScalePercent: 100,
      fileViewerFontScalePercent: 100,
      fontScalePercent: 100,
      terminalScrollSpeedPercent: 100,
      scrollSpeedPercent: 100,
    })).toBe(true)
    expect(UiSettings.isValid({ fontScalePercent: 100 })).toBe(false)
    expect(UiSettings.isValid({ fontScalePercent: 100, terminalFontScalePercent: '100' }))
      .toBe(false)
    // A write is the strict side, and what a read fills in a write has to carry: a section missing
    // the newest field alone is one this build refuses rather than stores half of.
    expect(UiSettings.isValid({
      fontScalePercent: 100,
      terminalFontScalePercent: 100,
      terminalTheme: 'original',
    })).toBe(false)
    // A write is strict where a read is lenient: a name outside the three names no colours at all,
    // so a save carrying one is refused rather than stored as something else.
    expect(UiSettings.isValid(section(100, 'powershell'))).toBe(false)
    expect(UiSettings.isValid({
      fontScalePercent: 100,
      fileViewerFontScalePercent: 100,
      terminalFontScalePercent: 100,
    })).toBe(false)
    for (const value of [null, undefined, 100, 'ui', []])
      expect(UiSettings.isValid(value)).toBe(false)
  })

  it('validates the bounds and the step of the font range', () => {
    const font = UiSettings.fontRangeConst
    for (const percent of [font.minPercent, font.maxPercent, 115])
      expect(UiSettings.isValid(section(percent))).toBe(true)
    for (const percent of [65, 155, 112, 100.5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(UiSettings.isValid(section(percent))).toBe(false)
  })

  // Its own bounds and its own step, which is the whole reason a range is a parameter: a speed of
  // 400 % is valid and a font scale of 400 % is not, and 105 is the other way round.
  it('validates a scroll speed against the scroll range', () => {
    const scroll = UiSettings.scrollRangeConst
    for (const percent of [scroll.minPercent, scroll.maxPercent, 175])
      expect(UiSettings.isValid({ ...UiSettings.defaultValue(), scrollSpeedPercent: percent }))
        .toBe(true)
    for (const percent of [25, 425, 110, 100.5, Number.NaN])
      expect(UiSettings.isValid({
        ...UiSettings.defaultValue(),
        terminalScrollSpeedPercent: percent,
      })).toBe(false)
  })

  it('snaps a percentage into the range and onto the step it was given', () => {
    const font = UiSettings.fontRangeConst
    expect(UiSettings.snap(112, font)).toBe(110)
    expect(UiSettings.snap(200, font)).toBe(150)
    expect(UiSettings.snap(0, font)).toBe(70)
    expect(UiSettings.snap(113, font)).toBe(115)
    expect(UiSettings.snap(115, font)).toBe(115)
    expect(UiSettings.snap(Number.NaN, font)).toBe(font.defaultPercent)

    const scroll = UiSettings.scrollRangeConst
    // 112 is nearer 100 than 125 on a grid of 25, which is the whole point of a coarser step.
    expect(UiSettings.snap(112, scroll)).toBe(100)
    expect(UiSettings.snap(113, scroll)).toBe(125)
    expect(UiSettings.snap(900, scroll)).toBe(400)
    expect(UiSettings.snap(0, scroll)).toBe(50)
    expect(UiSettings.snap(Number.NaN, scroll)).toBe(scroll.defaultPercent)
  })

  it('snaps every percentage to something it would then call valid', () => {
    for (let percent = 0; percent <= 500; percent += 1) {
      expect(UiSettings.isValid(section(UiSettings.snap(percent, UiSettings.fontRangeConst))))
        .toBe(true)
      expect(UiSettings.isValid({
        ...UiSettings.defaultValue(),
        scrollSpeedPercent: UiSettings.snap(percent, UiSettings.scrollRangeConst),
      })).toBe(true)
    }
  })

  // One conversion for both readers: xterm takes it as `scrollSensitivity` and the window's own
  // handler multiplies a delta by it, and the two dividing differently would be two speeds.
  it('hands a speed to its readers as a multiplier', () => {
    expect(UiSettings.scrollFactorOf(100)).toBe(1)
    expect(UiSettings.scrollFactorOf(250)).toBe(2.5)
    expect(UiSettings.scrollFactorOf(50)).toBe(0.5)
  })
})
