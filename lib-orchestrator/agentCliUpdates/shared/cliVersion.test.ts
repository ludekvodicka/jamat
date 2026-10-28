import { describe, expect, it } from 'vitest'
import { CliVersion } from './cliVersion'

describe('CliVersion', () => {
  it.each([
    ['1.10.0', '1.9.9', true], ['2.0.0', '1.99.99', true], ['1.1.1', '1.1.0', true],
    ['1.1.0', '1.1.0', false], ['1.1.0', '1.2.0', false], ['1.1.0', '1.1.0-alpha.1', true],
    ['1.1.0', '1.2.0-alpha.1', false],
  ])('compares stable release %s with installed %s', (latest, installed, newer) => {
    expect(CliVersion.newerRelease(latest, installed)).toBe(newer)
  })
  it('refuses a malformed feed instead of offering an arbitrary command argument', () => {
    expect(() => CliVersion.parse('1.2.3 && echo injected')).toThrow()
    expect(() => CliVersion.newerRelease('1.2.3-beta', '1.0.0')).toThrow()
  })
})
