import { describe, expect, it } from 'vitest'

import { WorktreeSettings } from './worktreeSettings'

describe('app-client-ui/shared/worktreeSettings', () => {
  function reported(value: unknown): { value: unknown; messages: string[] } {
    const messages: string[] = []
    return { value: WorktreeSettings.coerce(value, (message) => messages.push(message)), messages }
  }

  it('reads an absent section as the plain install, and says nothing about it', () => {
    expect(reported(undefined)).toEqual({
      value: { node: { pnpm: { globalVirtualStore: false } } },
      messages: [],
    })
  })

  it('reads a section that is not an object as the default, and says so', () => {
    const read = reported('on')
    expect(read.value).toEqual({ node: { pnpm: { globalVirtualStore: false } } })
    expect(read.messages).toHaveLength(1)
  })

  it('reads an unusable flag as false, and names what it found', () => {
    const read = reported({ node: { pnpm: { globalVirtualStore: 'yes' } } })
    expect(read.value).toEqual({ node: { pnpm: { globalVirtualStore: false } } })
    expect(read.messages[0]).toContain('"yes"')
  })

  /* An option a newer build wrote must survive an older one saving over the section. */
  it('keeps keys it does not know, at every level', () => {
    const read = reported({ future: 1, node: { deno: 2, pnpm: { strict: 3 } } })
    expect(read.value).toEqual({
      future: 1,
      node: { deno: 2, pnpm: { strict: 3, globalVirtualStore: false } },
    })
    expect(read.messages).toEqual([])
  })

  it('accepts a flag that is there and reads it as written', () => {
    expect(reported({ node: { pnpm: { globalVirtualStore: true } } }).value)
      .toEqual({ node: { pnpm: { globalVirtualStore: true } } })
  })

  it('refuses on the way in what it forgives on the way out', () => {
    expect(WorktreeSettings.isValid(WorktreeSettings.defaultValue())).toBe(true)
    expect(WorktreeSettings.isValid(undefined)).toBe(false)
    expect(WorktreeSettings.isValid({})).toBe(false)
    expect(WorktreeSettings.isValid({ node: {} })).toBe(false)
    expect(WorktreeSettings.isValid({ node: { pnpm: {} } })).toBe(false)
    expect(WorktreeSettings.isValid({ node: { pnpm: { globalVirtualStore: 'yes' } } })).toBe(false)
  })
})
