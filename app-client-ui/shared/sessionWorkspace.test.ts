import { expect, it } from 'vitest'
import { SessionWorkspaceKeys } from './sessionWorkspace'

it('qualifies matching session/document IDs by endpoint', () => {
  const targets = [{ kind: 'local', sessionId: 's' }, { kind: 'remote', remoteEndpointId: 'a', sessionId: 's' }, { kind: 'remote', remoteEndpointId: 'b', sessionId: 's' }] as const
  expect(new Set(targets.map((target) => SessionWorkspaceKeys.of(target, 'file'))).size).toBe(3)
})
