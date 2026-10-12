import { describe, expect, it } from 'vitest'

import { RemoteControlActivityLog } from './remoteControlActivityLog'

describe('lib-orchestrator/remoteControl/remoteControlActivityLog', () => {
  it('numbers entries from 1 and reads the ones after a revision', async () => {
    const log = new RemoteControlActivityLog(10, () => 5)
    log.publish('sessions.changed')
    log.publish('operation.completed', { operation: 'sessions.fork' })

    await expect(log.read(undefined, 0)).resolves.toEqual({
      entries: [
        { revision: 1, kind: 'sessions.changed', at: 5, data: {} },
        { revision: 2, kind: 'operation.completed', at: 5, data: { operation: 'sessions.fork' } },
      ],
      last: 2,
      truncated: false,
    })
    await expect(log.read(1, 0)).resolves.toMatchObject({ entries: [{ revision: 2 }], last: 2 })
    await expect(log.read(2, 0)).resolves.toEqual({ entries: [], last: 2, truncated: false })
  })

  it('waits for the first entry after the revision, and answers empty when the wait runs out', async () => {
    const log = new RemoteControlActivityLog()
    const waiting = log.read(0, 5_000)
    log.publish('tabs.changed')
    await expect(waiting).resolves.toMatchObject({ entries: [{ revision: 1, kind: 'tabs.changed' }], last: 1 })
    await expect(log.read(1, 20)).resolves.toEqual({ entries: [], last: 1, truncated: false })
  })

  it('says truncated when the entries after the revision were dropped, and reads from the start after a restart', async () => {
    const log = new RemoteControlActivityLog(2)
    for (let index = 0; index < 4; index += 1) log.publish('sessions.changed')

    // What is still kept comes along, and `truncated` says the entries before it are gone.
    await expect(log.read(0, 0)).resolves.toMatchObject({ entries: [{ revision: 3 }, { revision: 4 }], last: 4, truncated: true })
    // A number above the newest one comes from an earlier client start: everything kept is new.
    await expect(log.read(99, 0)).resolves.toMatchObject({
      entries: [{ revision: 3 }, { revision: 4 }],
      truncated: false,
    })
  })
})
