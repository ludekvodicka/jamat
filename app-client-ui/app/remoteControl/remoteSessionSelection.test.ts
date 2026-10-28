import { describe, expect, it } from 'vitest'

import { RemoteSessionSelection } from './remoteSessionSelection'

describe('RemoteSessionSelection', () => {
  const rows = [
    { sessionId: 'root' },
    { sessionId: 'child', parent: { sessionId: 'root', kind: 'worker' as const, sameProject: false } },
    { sessionId: 'grandchild', parent: { sessionId: 'child', kind: 'worktree' as const, sameProject: true } },
    { sessionId: 'run', script: { parentId: 'grandchild', phase: 'before' as const, scriptId: 'setup' as const } },
    { sessionId: 'other' },
  ]

  it('reaches recursive parent and script links without reaching siblings or ancestors', () => {
    expect([...RemoteSessionSelection.reachable(new Set(['root']), rows)])
      .toEqual(['root', 'child', 'grandchild', 'run'])
    expect([...RemoteSessionSelection.reachable(new Set(['child']), rows)])
      .toEqual(['child', 'grandchild', 'run'])
    expect([...RemoteSessionSelection.ancestors('run', rows)])
      .toEqual(['run', 'grandchild', 'child', 'root'])
  })

  it('terminates cycles and retains an independently selected child', () => {
    const cycle = [...rows, { sessionId: 'root', parent: { sessionId: 'run', kind: 'worker' as const, sameProject: true } }]
    expect(RemoteSessionSelection.reachable(new Set(['root', 'child']), cycle).size).toBe(4)
    expect(RemoteSessionSelection.ancestors('root', cycle).size).toBe(4)
    expect([...RemoteSessionSelection.reachable(new Set(['child']), rows)])
      .toEqual(['child', 'grandchild', 'run'])
    expect(RemoteSessionSelection.reachable(new Set(), cycle).size).toBe(0)
  })
})
