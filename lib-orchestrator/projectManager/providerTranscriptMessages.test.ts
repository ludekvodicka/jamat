import { describe, expect, it } from 'vitest'

import { ProviderTranscriptMessages } from './providerTranscriptMessages'

describe('lib-orchestrator/projectManager/providerTranscriptMessages', () => {
  function responseItem(content: unknown): unknown {
    return { type: 'response_item', payload: { type: 'message', role: 'user', content } }
  }

  function eventMessage(message: unknown): unknown {
    return { type: 'event_msg', payload: { type: 'user_message', message } }
  }

  it('reads an explicit user message and joins the parts of a fallback one', () => {
    expect(ProviderTranscriptMessages.codex(eventMessage('  what broke the build  ')))
      .toEqual({ kind: 'explicit', text: 'what broke the build' })
    expect(ProviderTranscriptMessages.codex(responseItem([{ text: 'what ' }, { text: 'broke it' }])))
      .toEqual({ kind: 'fallback', text: 'what broke it' })
  })

  /*
   * The rollout is another program's file, and this reader's own source says that format tolerates
   * schema churn. A `content` that arrived as a string used to meet `.map` here and throw - out of
   * `listProjectSessions`, whose comment says a rejection there would throw away the Claude listing
   * beside it. So the whole project's history went blank for both agents over one damaged rollout.
   */
  it('answers null for a payload whose shape is not what the tag promised', () => {
    for (const shape of [
      responseItem('not an array at all'),
      responseItem({ text: 'an object where a list was' }),
      responseItem(42),
      eventMessage(['not a string']),
      eventMessage({ text: 'nor an object' }),
      eventMessage(7),
    ])
      expect(ProviderTranscriptMessages.codex(shape)).toBeNull()
  })

  it('takes the parts of a list that are readable and ignores the rest', () => {
    expect(ProviderTranscriptMessages.codex(responseItem([
      { text: 'kept' },
      'a bare string',
      null,
      { text: 42 },
      { text: ' and this' },
    ]))).toEqual({ kind: 'fallback', text: 'kept and this' })
  })

  it('answers null for anything that is not a record at all', () => {
    for (const shape of [null, undefined, 'a line', 42, ['a', 'list']])
      expect(ProviderTranscriptMessages.codex(shape)).toBeNull()
  })
})
