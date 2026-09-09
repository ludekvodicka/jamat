import { describe, expect, it } from 'vitest'

import type {
  RemoteControlRequestUnion,
  RemoteControlSocketRequest,
} from './remoteControlApi.types'
import {
  RemoteControlEnvelope,
  RemoteControlLocalEnvelope,
  RemoteControlSocketEnvelope,
} from './remoteControlEnvelope'
import { RemoteControlConst } from './remoteControlProtocol'

/**
 * The answer envelope, which nothing measured while it was written out by hand in eight places.
 *
 * That is not an accident of this file being new: the copies were object literals inside private
 * statics, and every test that went through one of them asserted the VALUE it carried rather than
 * the four ids around it. Dropping `operationId` on the way out left every suite green.
 */
describe('lib-orchestrator/remoteControl/remoteControlEnvelope', () => {
  const requestConst = {
    protocol: RemoteControlConst.protocol,
    requestId: 'request-1',
    operation: 'sessions.create',
    operationId: 'operation-1',
    body: {},
  } as unknown as RemoteControlRequestUnion

  it('carries the protocol and all four ids of the request into a success', () => {
    expect(RemoteControlEnvelope.success(requestConst, { sessionId: 's1' })).toEqual({
      protocol: RemoteControlConst.protocol,
      requestId: 'request-1',
      operation: 'sessions.create',
      operationId: 'operation-1',
      ok: true,
      value: { sessionId: 's1' },
    })
  })

  // A read carries no operation id, and `undefined` is not `null`: one travels over the wire as an
  // absent key, and the validator on the other side reads an absent key and a null one differently.
  it('answers a request with no operation id with an explicit null', () => {
    const read = { ...requestConst, operationId: undefined } as unknown as RemoteControlRequestUnion

    expect(RemoteControlEnvelope.success(read, [])).toMatchObject({ operationId: null })
    expect(RemoteControlEnvelope.refused(read, { code: 'not-found', detail: 'no' }))
      .toMatchObject({ operationId: null })
  })

  it('takes the ids from the request it refuses', () => {
    expect(RemoteControlEnvelope.refused(requestConst, { code: 'forbidden', detail: 'no' }))
      .toEqual({
        protocol: RemoteControlConst.protocol,
        requestId: 'request-1',
        operation: 'sessions.create',
        operationId: 'operation-1',
        ok: false,
        error: { code: 'forbidden', detail: 'no' },
      })
  })

  // The other half: a request that could not be READ has only whatever ids were recovered from it.
  it('answers with the ids it was given when there is no request to read them off', () => {
    expect(RemoteControlEnvelope.failure(null, null, null, {
      code: 'invalid-request',
      detail: 'unreadable',
    })).toEqual({
      protocol: RemoteControlConst.protocol,
      requestId: null,
      operation: null,
      operationId: null,
      ok: false,
      error: { code: 'invalid-request', detail: 'unreadable' },
    })
  })

  describe('the socket family', () => {
    const mutationConst = {
      protocol: RemoteControlConst.protocol,
      requestId: 'request-2',
      operation: 'terminal.input',
      operationId: 'operation-2',
      attachId: 'attach-1',
      data: 'x',
    } as unknown as RemoteControlSocketRequest

    it('marks its answers as responses and keeps a mutation’s operation id', () => {
      expect(RemoteControlSocketEnvelope.success(mutationConst, { ok: true })).toEqual({
        protocol: RemoteControlConst.protocol,
        type: 'response',
        requestId: 'request-2',
        operation: 'terminal.input',
        operationId: 'operation-2',
        ok: true,
        value: { ok: true },
      })
    })

    /*
     * A subscription is a READ, and a read has no operation to be idempotent about. It answers with
     * no operation id whatever the caller sent, which is the one rule of this family that is not
     * simply "copy the request" - and the one a hand-written copy is most likely to miss.
     */
    it('answers a subscription with no operation id, whatever the caller sent', () => {
      const subscribe = {
        protocol: RemoteControlConst.protocol,
        requestId: 'request-3',
        operation: 'events.subscribe',
        operationId: 'operation-3',
        afterRevision: 0,
      } as unknown as RemoteControlSocketRequest

      expect(RemoteControlSocketEnvelope.success(subscribe, { events: [] }))
        .toMatchObject({ operationId: null })
      expect(RemoteControlSocketEnvelope.refused(subscribe, { code: 'forbidden', detail: 'no' }))
        .toMatchObject({ operationId: null })
    })

    it('answers a failure it could not read a request for with nulls', () => {
      expect(RemoteControlSocketEnvelope.failure(null, null, null, {
        code: 'invalid-request',
        detail: 'unreadable',
      })).toEqual({
        protocol: RemoteControlConst.protocol,
        type: 'response',
        requestId: null,
        operation: null,
        operationId: null,
        ok: false,
        error: { code: 'invalid-request', detail: 'unreadable' },
      })
    })
  })

  describe('the local family', () => {
    it('carries the same envelope over a local request', () => {
      const request = {
        protocol: RemoteControlConst.protocol,
        requestId: 'request-4',
        operation: 'peers.list',
        operationId: 'operation-4',
        body: {},
      } as unknown as Parameters<typeof RemoteControlLocalEnvelope.success>[0]

      expect(RemoteControlLocalEnvelope.success(request, { computers: [] } as never)).toEqual({
        protocol: RemoteControlConst.protocol,
        requestId: 'request-4',
        operation: 'peers.list',
        operationId: 'operation-4',
        ok: true,
        value: { computers: [] },
      })
    })

    it('answers a failure with the protocol and the ids it was given', () => {
      expect(RemoteControlLocalEnvelope.failure(null, null, null, {
        code: 'invalid-request',
        detail: 'unreadable',
      })).toEqual({
        protocol: RemoteControlConst.protocol,
        requestId: null,
        operation: null,
        operationId: null,
        ok: false,
        error: { code: 'invalid-request', detail: 'unreadable' },
      })
    })
  })
})
