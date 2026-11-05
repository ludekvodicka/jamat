import { describe, expect, it } from 'vitest'
import type { RuntimeSessionInfo } from '../../app-host/app/wire/hostWire'
import { SessionProcessTreeView } from './sessionProcessTreeView'

const runtime: RuntimeSessionInfo = { runtimeSessionId: 's', generation: 1, alive: true, pid: 1, processStartedAt: 10,
  cols: 80, rows: 24, outputSeq: 0, outputEpoch: 1, lastOutputAt: null, startedAt: 10 }
const session = { sessionId: 's', titleParts: { number: 'i34', name: 'Private title' }, kind: 'agent' as const, activity: 'idle' as const }

describe('session process ownership', () => {
  it('maps only live proven roots and bounded display selectors, without titles', () => {
    expect(SessionProcessTreeView.roots([runtime], [session])).toEqual([
      { pid: 1, startedAt: 10, sessionId: 's', session: 'i34', sessionKind: 'agent', idle: true },
    ])
    expect(SessionProcessTreeView.roots([runtime], [{ ...session, titleParts: { number: '014-015', name: 'Secret' },
      script: { parentId: 'parent', phase: 'inner', scriptId: 'requested' } }])[0]?.sessionKind).toBe('script')
    for (const number of [null, 'Private title', 'i' + '9'.repeat(100)])
      expect(SessionProcessTreeView.roots([runtime], [{ ...session, titleParts: { number, name: 'Secret' } }])).toEqual([])
    for (const changed of [{ alive: false }, { pid: undefined }, { processStartedAt: undefined }, { runtimeSessionId: 'missing' }])
      expect(SessionProcessTreeView.roots([{ ...runtime, ...changed }], [session])).toEqual([])
    expect(SessionProcessTreeView.roots([runtime], [{ ...session, kind: 'shell', activity: 'unknown' }])[0])
      .toMatchObject({ sessionKind: 'shell', idle: false })
  })

  it('requires original root start identity, valid parent ages and an acyclic chain', () => {
    const root = { pid: 1, startedAt: 10, sessionId: 's', session: '014-015', sessionKind: 'agent' as const, idle: true }
    const row = { pid: 2, parent: 1, startedAt: 20 }
    expect(SessionProcessTreeView.owner(row, new Map([[1, { pid: 1, parent: 0, startedAt: 10 }]]), [root])).toEqual(root)
    expect(SessionProcessTreeView.owner(row, new Map([[1, { pid: 1, parent: 0, startedAt: 30 }]]), [root])).toBeNull()
    expect(SessionProcessTreeView.owner(row, new Map([[1, { pid: 1, parent: 0, startedAt: 11.5 }]]), [root])).toBeNull()
    expect(SessionProcessTreeView.owner(row, new Map([[1, { pid: 1, parent: 2, startedAt: 20 }], [2, row]]), [])).toBeNull()
  })
})
