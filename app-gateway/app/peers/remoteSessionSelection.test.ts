import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

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
    assert.deepEqual([...RemoteSessionSelection.reachable(new Set(['root']), rows)], ['root', 'child', 'grandchild', 'run'])
    assert.deepEqual([...RemoteSessionSelection.reachable(new Set(['child']), rows)], ['child', 'grandchild', 'run'])
    assert.deepEqual([...RemoteSessionSelection.ancestors('run', rows)], ['run', 'grandchild', 'child', 'root'])
  })

  it('terminates cycles and retains an independently selected child', () => {
    const cycle = [...rows, { sessionId: 'root', parent: { sessionId: 'run', kind: 'worker' as const, sameProject: true } }]
    assert.equal(RemoteSessionSelection.reachable(new Set(['root', 'child']), cycle).size, 4)
    assert.equal(RemoteSessionSelection.ancestors('root', cycle).size, 4)
    assert.deepEqual([...RemoteSessionSelection.reachable(new Set(['child']), rows)], ['child', 'grandchild', 'run'])
    assert.equal(RemoteSessionSelection.reachable(new Set(), cycle).size, 0)
  })
})
