import { describe, expect, it } from 'vitest'

import { ErrorText } from './errorText'

describe('app-client-ui/shared/errorText', () => {
  it('reads the message of an Error', () => {
    expect(ErrorText.of(new Error('layout is not JSON'))).toBe('layout is not JSON')
  })

  it('reads the message of a subclass without its class name', () => {
    class LayoutError extends Error {}
    expect(ErrorText.of(new LayoutError('refused'))).toBe('refused')
  })

  // A rejected promise carries whatever was thrown, and a string is what a throwing library throws.
  it('stringifies what is not an Error', () => {
    expect(ErrorText.of('plain string')).toBe('plain string')
    expect(ErrorText.of(404)).toBe('404')
    expect(ErrorText.of(null)).toBe('null')
    expect(ErrorText.of(undefined)).toBe('undefined')
  })

  it('reads the stack of an Error as its detail', () => {
    const error = new Error('boot failed')
    expect(ErrorText.detailOf(error)).toBe(error.stack)
    expect(ErrorText.detailOf(error)).toMatch(/boot failed/)
  })

  it('falls back to the message of an Error carrying no stack', () => {
    const error = new Error('boot failed')
    error.stack = undefined
    expect(ErrorText.detailOf(error)).toBe('boot failed')
  })

  it('stringifies a detail that is not an Error', () => {
    expect(ErrorText.detailOf('exit 1')).toBe('exit 1')
  })
})
