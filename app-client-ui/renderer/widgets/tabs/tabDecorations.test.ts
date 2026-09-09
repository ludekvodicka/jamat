import { describe, expect, it } from 'vitest'

import {
  type TabBadge,
  type TabDecorations,
  TabDecorationsConst,
  TabDecorationsStore,
} from './tabDecorations'

class Decorations {
  static withBadges(badges: readonly TabBadge[]): TabDecorations {
    return { primary: null, secondary: null, badges }
  }

  static readonly working: TabDecorations = {
    primary: { glyph: '●', tone: 'ok', title: 'Working' },
    secondary: null,
    badges: [],
  }
}

describe('app-client-ui/renderer/widgets/tabs/tabDecorations', () => {
  // The reason the store is keyed at all: a status tick on one session must not re-render a strip
  // of twenty tabs that have nothing to do with it.
  it('notifies only the listeners of the panel that changed', () => {
    const store = new TabDecorationsStore()
    let changed = 0
    let untouched = 0
    store.subscribe('probe:1', () => { changed += 1 })
    store.subscribe('probe:2', () => { untouched += 1 })

    store.set('probe:1', Decorations.working)

    expect(store.get('probe:1')).toEqual(Decorations.working)
    expect(changed).toBe(1)
    expect(untouched).toBe(0)
  })

  // useSyncExternalStore compares snapshots by reference: a fresh empty object per read would put
  // the tab into a render loop rather than showing nothing.
  it('answers for an unpublished panel with one shared empty value', () => {
    const store = new TabDecorationsStore()

    expect(store.get('probe:none')).toBe(TabDecorationsConst.empty)
    expect(store.get('probe:none')).toBe(store.get('probe:other'))
  })

  it('forgets a cleared panel and tells its tab', () => {
    const store = new TabDecorationsStore()
    let notifications = 0
    store.subscribe('probe:1', () => { notifications += 1 })
    store.set('probe:1', Decorations.working)

    store.clear('probe:1')

    expect(store.get('probe:1')).toBe(TabDecorationsConst.empty)
    expect(notifications).toBe(2)
    // Nothing was published, so there is nothing to tell anyone about.
    store.clear('probe:1')
    expect(notifications).toBe(2)
  })

  it('stops notifying an unsubscribed listener', () => {
    const store = new TabDecorationsStore()
    let notifications = 0
    const unsubscribe = store.subscribe('probe:1', () => { notifications += 1 })

    unsubscribe()
    store.set('probe:1', Decorations.working)

    expect(notifications).toBe(0)
  })

  // A tab is not a rail row. Refusing the third badge here is what keeps that decision in one place.
  it('refuses more badges than a tab can carry, and keeps what it had', () => {
    const store = new TabDecorationsStore()
    store.set('probe:1', Decorations.working)
    const tooMany = Decorations.withBadges([
      { key: 'ro', text: 'RO', tone: 'muted', title: 'Read only' },
      { key: 'review', text: 'REVIEW', tone: 'ok', title: 'Ready for review' },
      { key: 'third', text: 'X', tone: 'danger', title: 'One too many' },
    ])

    expect(() => store.set('probe:1', tooMany)).toThrow(/at most 2 badges, got 3/)
    expect(store.get('probe:1')).toEqual(Decorations.working)
  })

  // Two badges under one key means React draws one of them and the other is silently gone.
  it('refuses two badges under the same key', () => {
    const store = new TabDecorationsStore()
    const duplicated = Decorations.withBadges([
      { key: 'ro', text: 'RO', tone: 'muted', title: 'Read only' },
      { key: 'ro', text: 'RO', tone: 'danger', title: 'Read only, again' },
    ])

    expect(() => store.set('probe:1', duplicated)).toThrow(/unique/)
  })
})
