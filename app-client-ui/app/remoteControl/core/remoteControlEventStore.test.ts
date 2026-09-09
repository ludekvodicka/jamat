import { describe, expect, it } from 'vitest'

import { RemoteControlEventStore } from './remoteControlEventStore'

describe('app-client-ui/app/remoteControl/core/remoteControlEventStore', () => {
  it('replays revisions after the cursor and reports either direction of a gap', () => {
    let now = 100
    const store = new RemoteControlEventStore(2, () => ++now)
    store.publish('sessions.changed')
    const second = store.publish('tabs.changed')
    const third = store.publish('sessions.changed')

    expect(store.replay(1)).toEqual({
      throughRevision: 3,
      truncated: false,
      events: [second, third],
    })
    expect(store.replay(0)).toEqual({ throughRevision: 3, truncated: true, events: [] })
    expect(store.replay(4)).toEqual({ throughRevision: 3, truncated: true, events: [] })
    expect(store.replay()).toEqual({ throughRevision: 3, truncated: false, events: [] })
  })
})
