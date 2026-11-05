import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PeerFrontDoor, type PeerRequestFamily } from './peerFrontDoor'

test('established input bypasses a slow operation while attach waits for earlier forwarded work', async () => {
  const door = new PeerFrontDoor()
  const seen: string[] = []
  let finish!: () => void
  const wait = new Promise<void>(resolve => { finish = resolve })
  const create = door.run('operation', async () => { seen.push('create'); await wait; seen.push('created') })
  const attach = door.run('attach', async () => { seen.push('attach') })
  const list = door.run('operation', async () => { seen.push('list') })
  await door.run('attached', async () => { seen.push('input') })
  assert.deepEqual(seen, ['input', 'create'])
  finish()
  await Promise.all([create, attach, list])
  assert.deepEqual(seen, ['input', 'create', 'created', 'attach', 'list'])
})

test('views keep their bound while close and attached traffic run immediately', async () => {
  const door = new PeerFrontDoor()
  let finish!: () => void
  const wait = new Promise<void>(resolve => { finish = resolve })
  let views = 0
  let overflow = 0
  let closed = false
  const pending = Array.from({ length: 16 }, () => door.run('view', async () => { views++; await wait }))
  await door.run('view', async () => { views++ }, { overflow: () => { overflow++ } })
  await door.run('view', async () => { closed = true }, { closeView: true })
  assert.equal(views, 16)
  assert.equal(overflow, 1)
  assert.equal(closed, true)
  finish()
  await Promise.all(pending)
  await door.run('view', async () => { views++ })
  assert.equal(views, 17)
})

test('an unknown family throws', () => {
  assert.throws(() => new PeerFrontDoor().run('unknown' as PeerRequestFamily, async () => {}), /Unknown peer request family/)
})
