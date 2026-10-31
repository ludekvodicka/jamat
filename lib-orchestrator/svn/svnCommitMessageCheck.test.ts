import { describe, expect, it } from 'vitest'

import { SvnCommitMessageCheck, type CommitMessageSource } from './svnCommitMessageCheck'

describe('SvnCommitMessageCheck', () => {
  it('accepts an ordinary proposed project message', () => {
    expect(SvnCommitMessageCheck.findings('[Jamat] Add X', 'agent-proposal')).toEqual([])
  })
  it('names the incident chat opening and missing project prefix', () => {
    expect(SvnCommitMessageCheck.findings('Shrnutí: U 043 zatím necommituj', 'agent-proposal')).toEqual(['no-prefix', 'chat-opening'])
  })
  it.each([
    'Here is the commit message for the change:\n[j12] J12 W4 app: limit 50',
    "Here's a commit message:",
    'Here’s the commit message you asked for',
    'Here are the commit messages:',
    'Sure, here is the message:',
    'Sure! [Jamat] Fix it',
    'Certainly. Fix the parser',
    'Okay, the commit:',
    'Of course, here it is',
    'Commit message:',
    'Suggested commit message: fix login',
    'Zde je commit message:',
    '[Jamat] Here is the commit message:',
  ])('names a chat opener in the first line of %j (UA1-J12-2)', (message) => {
    expect(SvnCommitMessageCheck.findings(message, 'agent-proposal')).toContain('chat-opening')
  })
  it.each([
    '[Jamat] Fix commit message parsing',
    '[Jamat] Commit message check covers chat openers',
    '[Jamat] Here-doc support in scripts',
    '[Jamat] Here is the fix for the parser',
    '[Jamat] Make sure the lease is released',
    '[Jamat] Surely-named helper',
    '[Jamat] Ok button closes the dialog',
    '[Jamat] Certainty level in the report',
    'Fix it\n\nHere is the commit message history',
  ])('keeps an ordinary first line %j free of the chat finding', (message) => {
    expect(SvnCommitMessageCheck.findings(message, 'agent-proposal')).not.toContain('chat-opening')
  })
  it('blocks empty even when the message was kept', () => {
    expect(SvnCommitMessageCheck.findings(' \n ', 'kept-attempt')).toEqual(['empty'])
  })
  it.each<CommitMessageSource>(['person-local', 'person-remote', 'agent-proposal', 'restored-draft', 'kept-attempt', 'unknown'])
    ('refuses a prefix without a description from %s even after acknowledgement and normalization', (source) => {
      for (const text of ['[applications]', '[applications]  ', '  [applications]\t\r\n ']) {
        const message = SvnCommitMessageCheck.withPrefix(text, '[applications]')
        expect(SvnCommitMessageCheck.blocking(message, source, ['empty', 'no-prefix', 'reused-after-keep'])).toEqual(['empty'])
        expect(SvnCommitMessageCheck.info(message, source)).toEqual([{ id: 'empty', text: 'Enter a commit message' }])
      }
      expect(SvnCommitMessageCheck.findings('[applications] \r\nDescribe the change', source)).not.toContain('empty')
    })
  it('checks first-line length, markdown and a kept attempt', () => {
    expect(SvnCommitMessageCheck.findings('[Jamat] ' + 'a'.repeat(93), 'unknown')).toEqual(['long-first-line'])
    expect(SvnCommitMessageCheck.findings('**Summary**', 'unknown')).toEqual(['no-prefix', 'markdown'])
    expect(SvnCommitMessageCheck.findings('- Fix it', 'unknown')).toEqual(['no-prefix', 'markdown'])
    expect(SvnCommitMessageCheck.findings('[Jamat] Fix it', 'kept-attempt')).toEqual(['reused-after-keep'])
  })
  it('asks a confirmation only for a message the person did not write', () => {
    expect(SvnCommitMessageCheck.blocking('Summary: fix', 'person-local', [])).toEqual([])
    expect(SvnCommitMessageCheck.blocking('', 'person-remote', [])).toEqual(['empty'])
    expect(SvnCommitMessageCheck.blocking('Summary: fix', 'agent-proposal', ['no-prefix'])).toEqual(['chat-opening'])
    expect(SvnCommitMessageCheck.info('Summary: fix', 'person-local').some((finding) => finding.confirm)).toBe(false)
    expect(SvnCommitMessageCheck.info('Summary: fix', 'agent-proposal').every((finding) => finding.confirm)).toBe(true)
  })
  it('adds a known repository prefix to a message without one', () => {
    expect(SvnCommitMessageCheck.withPrefix('  account provider', '[applications]')).toBe('[applications] account provider')
    expect(SvnCommitMessageCheck.withPrefix('[shared_backend] Fix', '[applications]')).toBe('[shared_backend] Fix')
    expect(SvnCommitMessageCheck.withPrefix(' ', '[applications]')).toBe(' ')
  })
  // Mirabia 113: a field the person emptied refused the worker's proposal as a person's message (2026-10-30).
  it('counts only a written field as a person message', () => {
    expect(SvnCommitMessageCheck.personMessage('[Mirabia] Fix search', 'person-local')).toBe(true)
    for (const message of ['', ' \n', '[Mirabia] ', '[Mirabia]'])
      expect(SvnCommitMessageCheck.personMessage(message, 'person-local')).toBe(false)
    expect(SvnCommitMessageCheck.personMessage('[Mirabia] Fix search', 'agent-proposal')).toBe(false)
  })
  it('tells whether a message publishes under the expected prefix', () => {
    expect(SvnCommitMessageCheck.prefixed('Fix the parser', '[applications_cvut]')).toBe(true)
    expect(SvnCommitMessageCheck.prefixed('[applications_cvut] Fix the parser', '[applications_cvut]')).toBe(true)
    expect(SvnCommitMessageCheck.prefixed('[worker-agent] Fix the parser', '[applications_cvut]')).toBe(false)
  })
})
