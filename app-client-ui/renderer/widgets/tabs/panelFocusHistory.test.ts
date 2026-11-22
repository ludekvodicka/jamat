import { describe, expect, it } from 'vitest'

import { PanelFocusHistory } from './panelFocusHistory'

describe('app-client-ui/renderer/widgets/tabs/panelFocusHistory', () => {
  const reopen = { key: 'terminal', title: 'A', params: { sessionId: 'a' } }

  it('lists the visited panels most recent first, once each, without the leaving one', () => {
    const history = new PanelFocusHistory()
    for (const id of ['a', 'b', 'a', 'c'])
      history.visited(id)

    expect(history.before('c').map((entry) => entry.panelId)).toEqual(['a', 'b'])
  })

  it('keeps a replaced preview through its removal and drops every other removed panel', () => {
    const history = new PanelFocusHistory()
    history.visited('a')
    history.visited('b')
    history.visited('c')
    history.replaced('a', reopen)

    history.removed('a')
    history.removed('b')

    expect(history.before('c')).toEqual([{ panelId: 'a', reopen }])
  })

  it('treats a reopened preview as open again', () => {
    const history = new PanelFocusHistory()
    history.visited('a')
    history.replaced('a', reopen)
    history.visited('a')

    history.removed('a')

    expect(history.before('x')).toEqual([])
  })

  it('holds at most 32 panels', () => {
    const history = new PanelFocusHistory()
    for (let index = 0; index < 40; index += 1)
      history.visited(`p${index}`)

    expect(history.before('none')).toHaveLength(32)
    expect(history.before('none')[31]?.panelId).toBe('p8')
  })
})
