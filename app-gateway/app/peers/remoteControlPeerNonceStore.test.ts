import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { RemoteControlPeerCodec } from '../../../lib-orchestrator/remoteControl/remoteControlPeerCodec'
import { RemoteControlPeerNonceStore } from './remoteControlPeerNonceStore'

describe('app-gateway/app/peers/remoteControlPeerNonceStore', () => {
  const skew = RemoteControlPeerCodec.maximumClockSkewMillisecondsConst

  it('refuses one nonce twice for a computer and admits it once it cannot be replayed', () => {
    let now = 1_000
    const store = new RemoteControlPeerNonceStore(() => now)

    assert.equal(store.accept('computer-a', 'nonce-a', now), true)
    assert.equal(store.accept('computer-a', 'nonce-a', now), false)
    assert.equal(store.accept('computer-b', 'nonce-a', now), true)

    now += skew + 1
    assert.equal(store.accept('computer-a', 'nonce-a', now), true)
  })

  /*
   * The window the codec accepts and the time this store remembers are ONE decision, and this is
   * where getting it wrong shows: a hello sent at the oldest moment the codec still calls fresh is
   * also the one whose nonce is closest to being forgotten. Forget it a moment early and that exact
   * hello - signed, fresh, already used - goes through a second time.
   */
  it('remembers the oldest hello the codec still accepts, to its last millisecond', () => {
    let now = 1_000_000
    const store = new RemoteControlPeerNonceStore(() => now)
    const sentAt = now - skew

    assert.equal(store.accept('computer-a', 'nonce-a', sentAt), true)
    assert.equal(store.accept('computer-a', 'nonce-a', sentAt), false)

    // Still inside the codec's window by one millisecond, so the replay must still be refused.
    now = sentAt + skew
    assert.equal(store.accept('computer-a', 'nonce-a', sentAt), false)

    // Past it: the codec would refuse this hello on its own now, and the entry is free to go.
    now = sentAt + skew + 1
    assert.equal(store.accept('computer-a', 'nonce-a', sentAt), true)
  })
})
