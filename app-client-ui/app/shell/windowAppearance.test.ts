import { describe, expect, it } from 'vitest'

import { WindowAppearanceRules } from './windowAppearance'

describe('app-client-ui/app/shell/windowAppearance', () => {
  it('trims a name, lowers a color and turns blanks into null', () => {
    expect(WindowAppearanceRules.normalize({ name: '  Review  ', color: ' #A1B2C3 ' }))
      .toEqual({ name: 'Review', color: '#a1b2c3' })
    expect(WindowAppearanceRules.normalize({ name: '   ', color: '' }))
      .toEqual({ name: null, color: null })
  })

  it('accepts duplicate names because identity is the window id', () => {
    expect(WindowAppearanceRules.normalize({ name: 'Review', color: null }).name).toBe('Review')
    expect(WindowAppearanceRules.normalize({ name: 'Review', color: null }).name).toBe('Review')
  })

  it('refuses long names and control characters', () => {
    expect(() => WindowAppearanceRules.normalize({ name: 'x'.repeat(81), color: null }))
      .toThrow(/exceeds 80/)
    expect(() => WindowAppearanceRules.normalize({ name: 'Review\nLogs', color: null }))
      .toThrow(/control characters/)
  })

  it('refuses anything other than a six-digit hex color', () => {
    expect(() => WindowAppearanceRules.normalize({ name: null, color: 'blue' }))
      .toThrow(/Invalid window color/)
    expect(() => WindowAppearanceRules.normalize({ name: null, color: '#123' }))
      .toThrow(/Invalid window color/)
  })
})
