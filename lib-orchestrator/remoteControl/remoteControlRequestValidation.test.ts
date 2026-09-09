import { describe, expect, it } from 'vitest'

import { RemoteControlConst } from './remoteControlProtocol'
import { RemoteControlRequestValidation } from './remoteControlRequestValidation'

/*
 * The 541 lines that stand between anything on the wire and the operations. It had no test file at
 * all until 2026-08-23, and four of its guards could be deleted with the suite still green - which
 * is the same as saying the door was never tried.
 */
describe('lib-orchestrator/remoteControl/remoteControlRequestValidation', () => {
  it('accepts a well formed request and returns exactly what was sent', () => {
    const parsed = RemoteControlRequestValidation.parse(RemoteControlRequestValidationTest.create({
      spec: { kind: 'shell', directory: { mode: 'default' } },
    }))

    expect(parsed).toEqual({
      ok: true,
      request: {
        protocol: RemoteControlConst.protocol,
        requestId: 'request-1',
        operation: 'sessions.create',
        operationId: 'operation-1',
        body: { spec: { kind: 'shell', directory: { mode: 'default' } } },
      },
    })
  })

  it('refuses another protocol before it reads anything else', () => {
    const parsed = RemoteControlRequestValidation.parse({
      ...RemoteControlRequestValidationTest.create({
        spec: { kind: 'shell', directory: { mode: 'default' } },
      }),
      protocol: 'appjamat-v2-control.v1',
    })

    expect(parsed).toMatchObject({ ok: false, error: { code: 'protocol-mismatch' } })
  })

  /*
   * The bound nothing tried. `requestId` and `operationId` are echoed back in every answer and
   * written into the audit line, so a megabyte of them is a megabyte this process holds and repeats
   * for a request it may well refuse. Deleting the length check left every suite green until now.
   */
  it('refuses an id longer than the envelope allows, on both ids', () => {
    const long = 'x'.repeat(257)

    expect(RemoteControlRequestValidation.parse({
      ...RemoteControlRequestValidationTest.create({ spec: { kind: 'shell', directory: { mode: 'default' } } }),
      requestId: long,
    })).toMatchObject({ ok: false, error: { code: 'invalid-request' } })

    const refused = RemoteControlRequestValidation.parse({
      ...RemoteControlRequestValidationTest.create({ spec: { kind: 'shell', directory: { mode: 'default' } } }),
      operationId: long,
    })
    expect(refused).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    if (refused.ok) throw new Error('A 257-character operationId was accepted')
    expect(refused.error.detail).toContain('exceeds 256 characters')
  })

  // The other end of the same rule: exactly the limit is a valid id, so the bound is not off by one.
  it('accepts an id of exactly the length the envelope allows', () => {
    expect(RemoteControlRequestValidation.parse({
      ...RemoteControlRequestValidationTest.create({ spec: { kind: 'shell', directory: { mode: 'default' } } }),
      requestId: 'x'.repeat(256),
    })).toMatchObject({ ok: true })
  })

  it('refuses a key nobody declared, so a typo is never silently dropped', () => {
    for (const input of [
      { ...RemoteControlRequestValidationTest.create({ spec: RemoteControlRequestValidationTest.shell }), extra: 1 },
      RemoteControlRequestValidationTest.create({
        spec: RemoteControlRequestValidationTest.shell,
        openTabs: true,
      }),
      RemoteControlRequestValidationTest.create({
        spec: { ...RemoteControlRequestValidationTest.shell, plain: true },
      }),
    ])
      expect(RemoteControlRequestValidation.parse(input))
        .toMatchObject({ ok: false, error: { code: 'invalid-request' } })
  })

  it('holds mutations to an operationId and refuses one on a read', () => {
    const withoutId = RemoteControlRequestValidation.parse({
      protocol: RemoteControlConst.protocol,
      requestId: 'request-1',
      operation: 'sessions.create',
      body: { spec: RemoteControlRequestValidationTest.shell },
    })
    const readWithId = RemoteControlRequestValidation.parse({
      protocol: RemoteControlConst.protocol,
      requestId: 'request-1',
      operation: 'sessions.list',
      operationId: 'operation-1',
      body: {},
    })

    expect(withoutId).toMatchObject({
      ok: false,
      operation: 'sessions.create',
      error: { code: 'invalid-request', detail: 'operationId is required for sessions.create' },
    })
    expect(readWithId).toMatchObject({
      ok: false,
      error: { detail: 'operationId is not allowed for sessions.list' },
    })
  })

  it('validates tabs.openFile as an exact replay-safe path request', () => {
    const valid = {
      protocol: RemoteControlConst.protocol,
      requestId: 'request-file',
      operation: 'tabs.openFile',
      operationId: 'operation-file',
      body: {
        session: { kind: 'number', number: '001' },
        path: 'reports/report.md',
      },
    }
    expect(RemoteControlRequestValidation.parse(valid)).toEqual({
      ok: true,
      request: valid,
    })
    for (const input of [
      { ...valid, operationId: undefined },
      { ...valid, body: { session: valid.body.session } },
      { ...valid, body: { ...valid.body, placement: 'split' } },
      { ...valid, body: { ...valid.body, path: 'x'.repeat(32_769) } },
    ])
      expect(RemoteControlRequestValidation.parse(input)).toMatchObject({
        ok: false,
        error: { code: 'invalid-request' },
      })
  })

  it('accepts sessions.transcript only as an exact read-only session request', () => {
    const valid = {
      protocol: RemoteControlConst.protocol,
      requestId: 'request-transcript',
      operation: 'sessions.transcript',
      body: { session: { kind: 'number', number: '014-015' } },
    }

    expect(RemoteControlRequestValidation.parse(valid)).toEqual({ ok: true, request: valid })
    for (const input of [
      { ...valid, operationId: 'operation-transcript' },
      { ...valid, body: { ...valid.body, includePaths: true } },
      { ...valid, body: { session: { kind: 'number', number: '14' } } },
    ])
      expect(RemoteControlRequestValidation.parse(input)).toMatchObject({
        ok: false,
        error: { code: 'invalid-request' },
      })
  })

  /*
   * A plain session is drawn by its tab and by nothing else, so one created without a tab is
   * invisible from the moment it starts and nothing cleans it up. The CLI parser now says so too,
   * but a peer never goes through a CLI parser.
   */
  it('refuses a plain session that does not ask for its tab', () => {
    const withoutTab = RemoteControlRequestValidation.parse(RemoteControlRequestValidationTest.create({
      spec: { ...RemoteControlRequestValidationTest.shell, presentation: 'tab' },
    }))
    const withTab = RemoteControlRequestValidation.parse(RemoteControlRequestValidationTest.create({
      spec: { ...RemoteControlRequestValidationTest.shell, presentation: 'tab' },
      openTab: true,
    }))

    expect(withoutTab).toMatchObject({
      ok: false,
      error: { code: 'invalid-request', detail: 'A session with presentation tab needs openTab: nothing else draws one' },
    })
    expect(withTab.ok).toBe(true)
  })

  it('accepts a three-digit number or fork pair and names the two selector kinds', () => {
    const answers = [
      { kind: 'number', number: '12' },
      { kind: 'number', number: '0012' },
      { kind: 'number', number: 'abc' },
      { kind: 'number', number: '014-x15' },
      { kind: 'number', number: '014-0015' },
      { kind: 'title', title: 'One' },
      { kind: 'sessionId', sessionId: '' },
    ].map((session) => RemoteControlRequestValidation.parse({
      protocol: RemoteControlConst.protocol,
      requestId: 'request-1',
      operation: 'sessions.reopen',
      operationId: 'operation-1',
      body: { session },
    }))

    for (const answer of answers)
      expect(answer).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    expect(RemoteControlRequestValidation.parse({
      protocol: RemoteControlConst.protocol,
      requestId: 'request-1',
      operation: 'sessions.reopen',
      operationId: 'operation-1',
      body: { session: { kind: 'number', number: '014' } },
    }).ok).toBe(true)
    expect(RemoteControlRequestValidation.parse({
      protocol: RemoteControlConst.protocol,
      requestId: 'request-1',
      operation: 'sessions.reopen',
      operationId: 'operation-1',
      body: { session: { kind: 'number', number: '014-015' } },
    }).ok).toBe(true)
  })

  it('refuses agent options without an agent and a base ref without a worktree', () => {
    const strayMode = RemoteControlRequestValidation.parse(RemoteControlRequestValidationTest.create({
      spec: { ...RemoteControlRequestValidationTest.shell, agent: { agentId: 'claude', mode: 'sideways' } },
    }))
    const strayBaseRef = RemoteControlRequestValidation.parse(RemoteControlRequestValidationTest.create({
      spec: { ...RemoteControlRequestValidationTest.shell, worktree: { baseRef: 'main' } },
    }))

    expect(strayMode).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    expect(strayBaseRef).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
  })

  /*
   * The additive field of Unit 7, and both halves of what "additive" has to mean here. This body is
   * validated with EXACT keys, so a target that predates the key refuses the whole request rather
   * than ignoring it - which is why the client sends it only where `agents.describe` was offered.
   * What this pins is the other side of that bargain: a request WITHOUT the key parses exactly as
   * it did before, and one with it is held to a shape that cannot be read as a flag.
   */
  it('takes an explicit agent model, holds it to a shape and leaves a request without one alone', () => {
    const withModel = RemoteControlRequestValidation.parse(RemoteControlRequestValidationTest.create({
      spec: {
        kind: 'agent',
        directory: { mode: 'default' },
        agent: { agentId: 'claude', mode: 'new', model: 'claude-opus-5[1m]' },
      },
    }))
    const withoutModel = RemoteControlRequestValidation.parse(RemoteControlRequestValidationTest.create({
      spec: {
        kind: 'agent',
        directory: { mode: 'default' },
        agent: { agentId: 'claude', mode: 'new' },
      },
    }))

    expect(withModel).toMatchObject({
      ok: true,
      request: { body: { spec: { agent: { model: 'claude-opus-5[1m]' } } } },
    })
    expect(withoutModel).toMatchObject({ ok: true })
    if (!withoutModel.ok) throw new Error('The fixture must parse')
    expect(withoutModel.request.body).toEqual({
      spec: {
        kind: 'agent',
        directory: { mode: 'default' },
        agent: { agentId: 'claude', mode: 'new' },
      },
    })

    for (const model of ['--dangerously', '-m', 'opus sonnet', 'opus&whoami', '', 7])
      expect(RemoteControlRequestValidation.parse(RemoteControlRequestValidationTest.create({
        spec: {
          kind: 'agent',
          directory: { mode: 'default' },
          agent: { agentId: 'claude', mode: 'new', model },
        },
      })), JSON.stringify(model)).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
  })

  it('reads agents.describe with an empty body and refuses one carrying anything', () => {
    const empty = RemoteControlRequestValidation.parse({
      protocol: RemoteControlConst.protocol,
      requestId: 'request-1',
      operation: 'agents.describe',
      body: {},
    })
    const carrying = RemoteControlRequestValidation.parse({
      protocol: RemoteControlConst.protocol,
      requestId: 'request-1',
      operation: 'agents.describe',
      body: { agentId: 'claude' },
    })

    expect(empty).toMatchObject({ ok: true, request: { operation: 'agents.describe', body: {} } })
    expect(carrying).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    expect(RemoteControlRequestValidation.isMutating('agents.describe')).toBe(false)
  })

  it('keeps the fingerprint on the operation and its body, so a retry is the same request', () => {
    const first = RemoteControlRequestValidation.parse(RemoteControlRequestValidationTest.create({
      spec: RemoteControlRequestValidationTest.shell,
    }))
    const retried = RemoteControlRequestValidation.parse({
      ...RemoteControlRequestValidationTest.create({ spec: RemoteControlRequestValidationTest.shell }),
      requestId: 'request-2',
    })
    const other = RemoteControlRequestValidation.parse(RemoteControlRequestValidationTest.create({
      spec: { kind: 'shell', directory: { mode: 'adHoc', path: 'Q:\\Apps' } },
    }))
    if (!first.ok || !retried.ok || !other.ok) throw new Error('The fixtures must parse')

    expect(RemoteControlRequestValidation.fingerprint(retried.request))
      .toBe(RemoteControlRequestValidation.fingerprint(first.request))
    expect(RemoteControlRequestValidation.fingerprint(other.request))
      .not.toBe(RemoteControlRequestValidation.fingerprint(first.request))
  })

  it('names the operation it could not find and reports the request id it did read', () => {
    const parsed = RemoteControlRequestValidation.parse({
      protocol: RemoteControlConst.protocol,
      requestId: 'request-9',
      operation: 'sessions.destroy',
      body: {},
    })

    expect(parsed).toMatchObject({
      ok: false,
      requestId: 'request-9',
      operation: null,
      error: { code: 'invalid-request' },
    })
  })
})

class RemoteControlRequestValidationTest {
  static readonly shell = { kind: 'shell', directory: { mode: 'default' } }

  static create(body: Record<string, unknown>): Record<string, unknown> {
    return {
      protocol: RemoteControlConst.protocol,
      requestId: 'request-1',
      operation: 'sessions.create',
      operationId: 'operation-1',
      body,
    }
  }
}
