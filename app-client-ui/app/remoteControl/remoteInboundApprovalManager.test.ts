import { describe, expect, it } from 'vitest'

import type {
  RemoteControlPeerIdentity,
} from '../../../lib-orchestrator/remoteControl/remoteControlPeerApi.types'
import {
  RemoteInboundApprovalManager,
  type RemoteInboundApprovalRequest,
} from './remoteInboundApprovalManager'

describe('app-client-ui/app/remoteControl/remoteInboundApprovalManager', () => {
  const addressConst = '203.0.113.20'

  it('writes the trust one Allow grants, and the next dial finds it', async () => {
    const test = new RemoteInboundApprovalManagerTest()
    const caller = RemoteInboundApprovalManagerTest.identity('endpoint-a')

    test.manager.request(caller, addressConst)

    expect(test.asked).toEqual([{
      remoteComputerId: 'computer-a',
      remoteEndpointId: 'endpoint-a',
      displayName: 'Studio endpoint-a',
      fingerprint: 'fingerprint-endpoint-a',
      remoteAddress: addressConst,
    }])
    await test.answer(true)
    expect(test.trustedOf(caller)).toEqual(caller)
    expect(test.changed).toBe(1)
    expect(test.errors).toEqual([])
  })

  /**
   * Brake 1's other half: a Deny is not merely "no", it is silence from that caller for the deny
   * window. The caller keeps redialling either way - nothing on the wire waits for this answer - so
   * without the window a refused stranger would raise the same dialog on every backoff step.
   */
  it('writes nothing on Deny and stays quiet for that identity until the deny window passes',
    async () => {
      const test = new RemoteInboundApprovalManagerTest()
      const caller = RemoteInboundApprovalManagerTest.identity('endpoint-a')

      test.manager.request(caller, addressConst)
      await test.answer(false)

      expect(test.trustedOf(caller)).toBeNull()
      expect(test.changed).toBe(0)

      // Past the ordinary prompt interval, and still inside the far longer deny suppression.
      test.clock += RemoteInboundApprovalManager.promptIntervalMillisecondsConst + 1
      test.manager.request(caller, addressConst)
      expect(test.asked).toHaveLength(1)

      test.clock += RemoteInboundApprovalManager.denySuppressionMillisecondsConst
      test.manager.request(caller, addressConst)
      expect(test.asked).toHaveLength(2)
    })

  /** Brake 3: one dialog at a time, so a second stranger cannot stack a box over the first one. */
  it('raises nothing for a second caller while one prompt is pending, and asks once it settles',
    async () => {
      const test = new RemoteInboundApprovalManagerTest()
      const first = RemoteInboundApprovalManagerTest.identity('endpoint-a')
      const second = RemoteInboundApprovalManagerTest.identity('endpoint-b')

      test.manager.request(first, addressConst)
      test.manager.request(second, addressConst)

      expect(test.asked).toHaveLength(1)

      await test.answer(false)
      test.manager.request(second, addressConst)

      expect(test.asked.map((request) => request.remoteEndpointId))
        .toEqual(['endpoint-a', 'endpoint-b'])
    })

  /** The Allow race: the caller redials between the refusal that raised the dialog and the write. */
  it('asks nobody about a caller that is already trusted', async () => {
    const test = new RemoteInboundApprovalManagerTest()
    const caller = RemoteInboundApprovalManagerTest.identity('endpoint-a')
    test.manager.request(caller, addressConst)
    await test.answer(true)

    test.manager.request(caller, addressConst)

    expect(test.asked).toHaveLength(1)
  })

  /**
   * Brake 4, on the path that leaves the identity neither trusted nor denied: the prompt was raised
   * and never answered by a person. One per interval is what keeps a caller from turning a redial
   * loop into a stream of dialogs.
   */
  it('asks once per identity per interval', async () => {
    const test = new RemoteInboundApprovalManagerTest()
    const caller = RemoteInboundApprovalManagerTest.identity('endpoint-a')
    test.manager.request(caller, addressConst)
    await test.fail('The window it was asked over has gone')

    test.clock += RemoteInboundApprovalManager.promptIntervalMillisecondsConst - 1
    test.manager.request(caller, addressConst)
    expect(test.asked).toHaveLength(1)

    test.clock += 1
    test.manager.request(caller, addressConst)
    expect(test.asked).toHaveLength(2)
  })

  /**
   * The bound is what makes brake 4 safe to keep: the map is keyed by an identity the CALLER
   * chooses, so a flood of invented ones must cost memory that stops growing rather than memory
   * that does not.
   */
  it('forgets the oldest identity once the recent map is full', async () => {
    const test = new RemoteInboundApprovalManagerTest()
    const bound = RemoteInboundApprovalManagerTest.recentBound()
    for (let index = 0; index <= bound; index += 1) {
      test.manager.request(RemoteInboundApprovalManagerTest.identity(`endpoint-${index}`), addressConst)
      await test.answer(false)
    }
    expect(test.asked).toHaveLength(bound + 1)

    // Inside its own deny window, so only the eviction can let it through again.
    test.manager.request(RemoteInboundApprovalManagerTest.identity('endpoint-0'), addressConst)

    expect(test.asked).toHaveLength(bound + 2)
  })

  it('releases the latch and reports a confirm that failed instead of granting anything', async () => {
    const test = new RemoteInboundApprovalManagerTest()
    const first = RemoteInboundApprovalManagerTest.identity('endpoint-a')
    const second = RemoteInboundApprovalManagerTest.identity('endpoint-b')

    test.manager.request(first, addressConst)
    await test.fail('The window it was asked over has gone')

    expect(test.errors)
      .toEqual(['Inbound approval failed: The window it was asked over has gone'])
    expect(test.trustedOf(first)).toBeNull()
    expect(test.changed).toBe(0)

    test.manager.request(second, addressConst)
    expect(test.asked).toHaveLength(2)
  })
})

class RemoteInboundApprovalManagerTest {
  readonly asked: RemoteInboundApprovalRequest[] = []
  readonly errors: string[] = []
  readonly manager: RemoteInboundApprovalManager
  changed = 0
  clock = 1_000
  private readonly trusted = new Map<string, RemoteControlPeerIdentity>()
  private readonly waiting: {
    resolve(answer: boolean): void
    reject(error: Error): void
  }[] = []

  constructor() {
    this.manager = new RemoteInboundApprovalManager({
      credentials: {
        trustedInbound: (remoteComputerId, remoteEndpointId) =>
          this.trusted.get(`${remoteComputerId} ${remoteEndpointId}`) ?? null,
        trustInbound: (identity) => {
          this.trusted.set(
            `${identity.remoteComputerId} ${identity.remoteEndpointId}`,
            identity,
          )
        },
      },
      confirm: (request) => {
        this.asked.push(request)
        return new Promise<boolean>((resolve, reject) => {
          this.waiting.push({ resolve, reject })
        })
      },
      onChanged: () => { this.changed += 1 },
      onError: (message) => { this.errors.push(message) },
      now: () => this.clock,
    })
  }

  trustedOf(identity: RemoteControlPeerIdentity): RemoteControlPeerIdentity | null {
    return this.trusted.get(`${identity.remoteComputerId} ${identity.remoteEndpointId}`) ?? null
  }

  async answer(allowed: boolean): Promise<void> {
    RemoteInboundApprovalManagerTest.pending(this.waiting).resolve(allowed)
    await RemoteInboundApprovalManagerTest.settle()
  }

  async fail(message: string): Promise<void> {
    RemoteInboundApprovalManagerTest.pending(this.waiting).reject(new Error(message))
    await RemoteInboundApprovalManagerTest.settle()
  }

  static identity(remoteEndpointId: string): RemoteControlPeerIdentity {
    return {
      remoteComputerId: 'computer-a',
      remoteEndpointId,
      configIdentity: 'config-a',
      runtimeChannel: 'development',
      displayName: `Studio ${remoteEndpointId}`,
      signing: {
        algorithm: 'ed25519',
        publicKey: `key-${remoteEndpointId}`,
        fingerprint: `fingerprint-${remoteEndpointId}`,
      },
    }
  }

  /** Private to the manager and read here anyway: the eviction cannot be asserted without it. */
  static recentBound(): number {
    return (RemoteInboundApprovalManager as unknown as { recentBoundConst: number }).recentBoundConst
  }

  private static pending(waiting: {
    resolve(answer: boolean): void
    reject(error: Error): void
  }[]): { resolve(answer: boolean): void; reject(error: Error): void } {
    const next = waiting.shift()
    if (next === undefined) throw new Error('No confirmation is waiting for an answer')
    return next
  }

  /** The prompt is raised fire-and-forget, so the answer lands a few microtasks after it is given. */
  private static settle(): Promise<void> {
    return new Promise((resolve) => { setTimeout(resolve, 0) })
  }
}
