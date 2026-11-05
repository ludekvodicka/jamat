import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ViewerBuffer } from './viewerBuffer'

test('counts in-flight bytes, stops a slow generation, and leaves another viewer independent', () => {
  const slow: { generation: number; sequence: number }[] = [], fast: string[] = [], truncations: number[] = []
  let resumed = 0
  const blocked = new ViewerBuffer<string>({ send: (_value, generation, sequence) => slow.push({ generation, sequence }),
    bytesOf: (value, generation, sequence) => Buffer.byteLength(JSON.stringify({ value, generation, sequence })),
    truncate: generation => truncations.push(generation), resume: () => { resumed++ } })
  const flowing = new ViewerBuffer<string>({ send: (value, generation, sequence) => {
    fast.push(value); flowing.received(generation, sequence)
  }, bytesOf: (value, generation, sequence) => Buffer.byteLength(JSON.stringify({ value, generation, sequence })),
  truncate: () => assert.fail('fast viewer truncated'), resume() {} })
  const chunk = 'x'.repeat(512 * 1024)
  for (let index = 0; index < 100; index++) {
    blocked.push(chunk)
    flowing.push(`fast-${index}`)
  }
  assert.equal(slow.length, 3)
  assert.equal(fast.length, 100)
  assert.deepEqual(truncations, [2])
  blocked.resetReceived(2)
  assert.equal(resumed, 0)
  for (const frame of slow) blocked.received(frame.generation, frame.sequence)
  blocked.resetReceived(1)
  assert.equal(resumed, 0)
  blocked.resetReceived(2)
  assert.equal(resumed, 1)
  assert.equal(blocked.push('fresh snapshot'), true)
  assert.equal(slow.at(-1)?.generation, 2)
  for (const frame of slow.slice(0, 3)) blocked.received(frame.generation, frame.sequence)
  assert.equal(blocked.push('y'.repeat(ViewerBuffer.bytesMaxConst)), false)
  assert.deepEqual(truncations, [2, 3])
  blocked.resetReceived(3)
  assert.equal(resumed, 1)
  const fresh = slow.at(-1)!
  blocked.received(fresh.generation, fresh.sequence)
  blocked.resetReceived(2)
  assert.equal(resumed, 1)
  blocked.resetReceived(3)
  assert.equal(resumed, 2)
  blocked.close()
  flowing.close()
  assert.equal(blocked.push('after close'), false)
})

test('admits payload-free reservations fairly and never exceeds aggregate native credit across many snapshots', async () => {
  const frames: { value: string; generation: number; sequence: number }[] = []
  let nativeBytes = 0, maximum = 0
  const buffer = new ViewerBuffer<string>({ bytesOf: value => value.length,
    send: (value, generation, sequence) => { frames.push({ value, generation, sequence }); nativeBytes += value.length; maximum = Math.max(maximum, nativeBytes) },
    truncate: () => assert.fail('credit-controlled snapshots must not truncate'), resume() {} })
  const abort = new AbortController()
  const admitted: number[] = []
  const tasks = Array.from({ length: 48 }, (_, index) => buffer.reserve(65_536, abort.signal).then(slot => {
    admitted.push(index)
    return slot.send('x'.repeat(65_536))
  }))
  await Promise.resolve()
  assert.equal(frames.length, 32)
  assert.deepEqual(admitted, Array.from({ length: 32 }, (_, index) => index))
  const first = frames[0]!
  buffer.received(first.generation + 1, first.sequence)
  await Promise.resolve()
  assert.equal(frames.length, 32)
  for (let index = 0; index < 48; index++) {
    const frame = frames[index]!
    assert.ok(frame)
    nativeBytes -= frame.value.length
    buffer.received(frame.generation, frame.sequence)
    buffer.received(frame.generation, frame.sequence)
    await Promise.resolve()
  }
  await Promise.all(tasks)
  assert.equal(maximum, ViewerBuffer.bytesMaxConst)
  assert.equal(nativeBytes, 0)
  assert.deepEqual(admitted, Array.from({ length: 48 }, (_, index) => index))
  buffer.close()
})

test('cancels queued and unused slots but retains cancelled native bytes until their real receipt', async () => {
  const sent: { generation: number; sequence: number }[] = []
  const buffer = new ViewerBuffer<string>({ bytesOf: value => value.length,
    send: (_value, generation, sequence) => sent.push({ generation, sequence }), truncate() {}, resume() {} })
  const owner = new AbortController(), queuedOwner = new AbortController()
  const slot = await buffer.reserve(ViewerBuffer.bytesMaxConst, owner.signal)
  const cancelledQueue = assert.rejects(buffer.reserve(1, queuedOwner.signal), /cancelled/)
  queuedOwner.abort()
  await cancelledQueue
  const delivery = assert.rejects(slot.send('x'.repeat(ViewerBuffer.bytesMaxConst)), /cancelled/)
  owner.abort()
  await delivery
  let admitted = false
  const next = buffer.reserve(1, new AbortController().signal).then(value => { admitted = true; return value })
  await Promise.resolve()
  assert.equal(admitted, false)
  buffer.received(sent[0]!.generation, sent[0]!.sequence)
  const unused = await next
  unused.release()
  const retry = await buffer.reserve(ViewerBuffer.bytesMaxConst, new AbortController().signal)
  const failed = assert.rejects(retry.send('y'), /failed/)
  buffer.received(sent[1]!.generation, sent[1]!.sequence, true)
  await failed
  buffer.close()
})
