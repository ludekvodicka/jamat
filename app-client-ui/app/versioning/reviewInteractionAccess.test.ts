import { expect, it } from 'vitest'
import { ReviewInteractionAccess } from './reviewInteractionAccess'

it('refuses copied caller claims and revokes the admitted local interaction', () => {
  const access = new ReviewInteractionAccess()
  let alive = true
  const human = access.local('window', 'session', () => alive)
  expect(access.isActive(human)).toBe(true)
  expect(access.isActive({ ...human })).toBe(false)
  alive = false
  expect(access.isActive(human)).toBe(false)
})

it('binds peer provenance to a source view while keeping the actor stable across reconnects', () => {
  const access = new ReviewInteractionAccess()
  const view = { peerId: 'peer', sessionId: 'source', viewerId: 'viewer', viewId: 'lease', epoch: 'connection' }
  let alive = true
  const first = access.peer(view, 'owner-one', () => alive)
  const second = access.peer({ ...view, viewId: 'replacement' }, 'owner-two', () => true)
  alive = false
  expect(access.isActive(first)).toBe(false)
  expect(access.isActive(second)).toBe(true)
  expect(second.actorId).toBe(first.actorId)
  expect(second.sessionId).toBe('source')
  expect(second.ownerId).not.toBe(first.ownerId)
})
