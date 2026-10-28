import { describe, expect, it } from 'vitest'

import { SvnFailures } from './svnFailures'

describe('SvnFailures', () => {
  it.each([
    ['out-of-date', ['E155011', 'E160028', 'E170004', 'E160024', 'E160042', 'out of date']],
    ['locked', ['E155004', 'E155037', 'is locked']],
    ['auth', ['E170001', 'E215004', 'E230001', 'Authentication failed']],
    ['network', ['E170013', 'E175012', 'E731001']],
    ['conflict', ['E155015']],
    ['other', ['unknown failure']],
  ] as const)('classifies %s independently of localized text', (kind, outputs) => {
    for (const output of outputs) expect(SvnFailures.classify(output, 1)).toBe(kind)
  })

  it('reads positive revision receipts and XML revisions', () => {
    expect(SvnFailures.revisionOf('Sending file\r\nCommitted revision 42.\r\n')).toBe(42)
    expect(SvnFailures.revisionOf('Uložena revize 42.')).toBeNull()
    expect(SvnFailures.infoRevisionOf('<info><entry revision="42"/></info>')).toBe(42)
    expect(SvnFailures.infoRevisionOf('<info/>')).toBeNull()
  })
})
