import { describe, it, expect } from 'vitest'
import { resolveDiffModeOnOptions } from './diff-mode-resolve'

// Guards the FileViewer regression where a slow getFileDiffOptions resolve
// overwrote the user's diff-mode pick with the smart default.
describe('resolveDiffModeOnOptions', () => {
  it('initial mode wins regardless of user pick', () => {
    expect(resolveDiffModeOnOptions(true, false)).toBe('initial')
    expect(resolveDiffModeOnOptions(true, true)).toBe('initial')
  })

  it('applies the smart default when no initial mode and user has not picked', () => {
    expect(resolveDiffModeOnOptions(false, false)).toBe('default')
  })

  it('keeps the user pick — a late options resolve must not clobber it', () => {
    expect(resolveDiffModeOnOptions(false, true)).toBe('keep')
  })
})
