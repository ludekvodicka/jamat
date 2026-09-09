import { describe, expect, it } from 'vitest'

import { RemoteControlConst } from '../../../../lib-orchestrator/remoteControl/remoteControlProtocol'
import { RemoteControlSocketValidation } from './remoteControlSocketValidation'

describe('app-client-ui/app/remoteControl/core/remoteControlSocketValidation', () => {
  it('accepts every socket operation and fingerprints terminal input with its data', () => {
    const messages = [
      { protocol: RemoteControlConst.protocol, requestId: 'r0', operation: 'events.subscribe' },
      {
        protocol: RemoteControlConst.protocol,
        requestId: 'r1',
        operationId: 'o1',
        operation: 'terminal.attach',
        attachId: 'a1',
        sessionId: 's1',
        size: { cols: 80, rows: 24 },
      },
      {
        protocol: RemoteControlConst.protocol,
        requestId: 'r2',
        operationId: 'o2',
        operation: 'terminal.input',
        attachId: 'a1',
        data: 'status\r',
      },
      {
        protocol: RemoteControlConst.protocol,
        requestId: 'r3',
        operationId: 'o3',
        operation: 'terminal.resize',
        attachId: 'a1',
        cols: 100,
        rows: 30,
      },
      {
        protocol: RemoteControlConst.protocol,
        requestId: 'r4',
        operationId: 'o4',
        operation: 'terminal.active',
        attachId: 'a1',
        active: true,
      },
      {
        protocol: RemoteControlConst.protocol,
        requestId: 'r5',
        operationId: 'o5',
        operation: 'terminal.detach',
        attachId: 'a1',
      },
    ]
    const parsed = messages.map((message) => RemoteControlSocketValidation.parse(message))
    expect(parsed.every((answer) => answer.ok)).toBe(true)
    const input = parsed[2]
    if (!input?.ok || input.request.operation === 'events.subscribe')
      throw new Error('terminal.input did not pass validation')
    expect(RemoteControlSocketValidation.fingerprint(input.request)).toContain('status\\r')
  })

  it('rejects protocol, unknown fields, missing operation ids and invalid bounds', () => {
    const invalid = [
      null,
      { protocol: 'old', requestId: 'r', operation: 'events.subscribe' },
      {
        protocol: RemoteControlConst.protocol,
        requestId: 'r',
        operation: 'events.subscribe',
        extra: true,
      },
      {
        protocol: RemoteControlConst.protocol,
        requestId: 'r',
        operation: 'terminal.detach',
        attachId: 'a',
      },
      {
        protocol: RemoteControlConst.protocol,
        requestId: 'r',
        operationId: 'o',
        operation: 'terminal.resize',
        attachId: 'a',
        cols: 1,
        rows: 24,
      },
    ]
    const answers = invalid.map((message) => RemoteControlSocketValidation.parse(message))
    expect(answers.every((answer) => !answer.ok)).toBe(true)
    expect(answers[1]).toMatchObject({ ok: false, error: { code: 'protocol-mismatch' } })
  })
})
