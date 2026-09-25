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

  it('requires an explicit commit VCS and a bounded proposal with no unknown fields', () => {
    const valid = { protocol: RemoteControlConst.protocol, requestId: 'commit', operation: 'tabs.openCommit', operationId: 'open-commit',
      body: { session: { kind: 'number', number: '001' }, vcs: 'svn', scope: 'shared', message: 'Subject\n\nBody' } }
    expect(RemoteControlRequestValidation.parse(valid)).toEqual({ ok: true, request: valid })
    for (const body of [{ ...valid.body, vcs: undefined }, { ...valid.body, vcs: 'hg' }, { ...valid.body, commit: true }, { ...valid.body, message: 'x'.repeat(65_537) }])
      expect(RemoteControlRequestValidation.parse({ ...valid, body })).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    const selected = { ...valid, body: { ...valid.body, paths: ['Q:/outside/one.txt', 'Q:/outside/two.txt'] } }
    expect(RemoteControlRequestValidation.parse(selected)).toEqual({ ok: true, request: selected })
    for (const paths of [[], [''], [1], null, 'file.txt', Array(2_001).fill('file.txt')])
      expect(RemoteControlRequestValidation.parse({ ...valid, body: { ...valid.body, paths } }).ok).toBe(false)
    expect(RemoteControlConst.optionalOperations).toContain('tabs.openCommit')
    expect(RemoteControlConst.mutatingOperations).toContain('tabs.openCommit')
    expect(RemoteControlRequestValidation.parse({ ...valid, operation: 'vcs.commit' }).ok).toBe(false)
  })

  it('accepts only a read-only query of one commit UUID', () => {
    const valid = { protocol: RemoteControlConst.protocol, requestId: 'status', operation: 'tabs.commitStatus',
      body: { commitSessionId: '11111111-1111-4111-8111-111111111111' } }
    expect(RemoteControlRequestValidation.parse(valid)).toEqual({ ok: true, request: valid })
    for (const input of [{ ...valid, operationId: 'mutate' }, { ...valid, body: {} },
      { ...valid, body: { commitSessionId: 'wrong' } }, { ...valid, body: { ...valid.body, commit: true } }])
      expect(RemoteControlRequestValidation.parse(input)).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    expect(RemoteControlConst.mutatingOperations).not.toContain('tabs.commitStatus')
  })

  it('requires a replay identity and exact UUID for commit cancellation', () => {
    const valid = { protocol: RemoteControlConst.protocol, requestId: 'cancel', operation: 'tabs.cancelCommit', operationId: 'cancel-1',
      body: { commitSessionId: '11111111-1111-4111-8111-111111111111' } }
    expect(RemoteControlRequestValidation.parse(valid)).toEqual({ ok: true, request: valid })
    for (const input of [{ ...valid, operationId: undefined }, { ...valid, body: {} },
      { ...valid, body: { commitSessionId: 'wrong' } }, { ...valid, body: { ...valid.body, force: true } }])
      expect(RemoteControlRequestValidation.parse(input)).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    expect(RemoteControlConst.optionalOperations).toContain('tabs.cancelCommit')
    expect(RemoteControlConst.mutatingOperations).toContain('tabs.cancelCommit')
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

  it('holds terminal.deliver to an operation id, a non-empty text, its mode and its timeout bounds', () => {
    const valid = {
      protocol: RemoteControlConst.protocol,
      requestId: 'request-deliver',
      operation: 'terminal.deliver',
      operationId: 'operation-deliver',
      body: { session: { kind: 'sessionId', sessionId: 'session-1' }, text: 'Read the file.' },
    }
    const full = {
      ...valid,
      body: { ...valid.body, input: 'typed', readyTimeoutMs: 120_000, submitTimeoutMs: 60_000, queue: true },
    }
    const multiLinePaste = { ...valid, body: { ...valid.body, text: 'one\ntwo', input: 'paste' } }
    const longPaste = { ...valid, body: { ...valid.body, text: 'x'.repeat(801) } }

    expect(RemoteControlRequestValidation.parse(valid)).toEqual({ ok: true, request: valid })
    expect(RemoteControlRequestValidation.parse(full)).toEqual({ ok: true, request: full })
    expect(RemoteControlRequestValidation.parse(multiLinePaste)).toEqual({ ok: true, request: multiLinePaste })
    expect(RemoteControlRequestValidation.parse(longPaste)).toEqual({ ok: true, request: longPaste })
    const { operationId: _operationId, ...withoutOperationId } = valid
    for (const input of [
      withoutOperationId,
      { ...valid, body: { ...valid.body, enter: true } },
      { ...valid, body: { ...valid.body, text: '' } },
      { ...valid, body: { ...valid.body, text: '', input: 'typed' } },
      { ...valid, body: { ...valid.body, text: 'one\ntwo', input: 'typed' } },
      { ...valid, body: { ...valid.body, text: 'one\rtwo', input: 'typed' } },
      { ...valid, body: { ...valid.body, text: 'x'.repeat(801), input: 'typed' } },
      { ...valid, body: { ...valid.body, input: 'keys' } },
      { ...valid, body: { ...valid.body, readyTimeoutMs: 999 } },
      { ...valid, body: { ...valid.body, readyTimeoutMs: 120_001 } },
      { ...valid, body: { ...valid.body, submitTimeoutMs: 999 } },
      { ...valid, body: { ...valid.body, submitTimeoutMs: 60_001 } },
      { ...valid, body: { ...valid.body, submitTimeoutMs: 1_500.5 } },
      { ...valid, body: { ...valid.body, queue: 'yes' } },
    ])
      expect(RemoteControlRequestValidation.parse(input)).toMatchObject({
        ok: false,
        error: { code: 'invalid-request' },
      })
    expect(RemoteControlRequestValidation.parse({ ...valid, body: { ...valid.body, text: 'x'.repeat(800), input: 'typed' } }))
      .toMatchObject({ ok: true })
  })

  it('refuses terminal.deliver text whose control characters could end a paste or edit the composer', () => {
    const deliver = (text: string, input: 'paste' | 'typed') => RemoteControlRequestValidation.parse({
      protocol: RemoteControlConst.protocol,
      requestId: 'request-deliver',
      operation: 'terminal.deliver',
      operationId: 'operation-deliver',
      body: { session: { kind: 'sessionId', sessionId: 'session-1' }, text, input },
    })

    for (const text of ['a\x1b[201~\rb', 'a\x1bb', 'a\x00b', 'a\x03b', 'a\x08b', 'a\x0bb', 'a\x1fb'])
      expect(deliver(text, 'paste'), JSON.stringify(text)).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    expect(deliver('one\r\ntwo\tthree', 'paste')).toMatchObject({ ok: true })
    for (const text of ['a\tb', 'a\x1bb', 'a\x7fb', 'a\x00b', 'a\x15b'])
      expect(deliver(text, 'typed'), JSON.stringify(text)).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    expect(deliver('plain words', 'typed')).toMatchObject({ ok: true })
  })

  /*
   * `presentation` said a session was drawn by its tab alone. It is gone as of 2026-09-23, and the
   * exact-key check is what makes an older peer's create fail as a whole rather than quietly
   * starting a session with a field nothing here reads.
   */
  it('refuses a create that still carries the retired presentation field', () => {
    expect(RemoteControlRequestValidation.parse(RemoteControlRequestValidationTest.create({
      spec: { ...RemoteControlRequestValidationTest.shell, presentation: 'tab' },
      openTab: true,
    }))).toMatchObject({
      ok: false,
      error: { code: 'invalid-request' },
    })
  })

  it('takes every shape a session number slot can hold, and nothing else', () => {
    const selector = (session: unknown) => RemoteControlRequestValidation.parse({
      protocol: RemoteControlConst.protocol,
      requestId: 'request-1',
      operation: 'sessions.reopen',
      operationId: 'operation-1',
      body: { session },
    })

    const refused = [
      { kind: 'number', number: '12' },
      { kind: 'number', number: 'abc' },
      { kind: 'number', number: 'abcd12' },
      { kind: 'number', number: 'i1234567' },
      { kind: 'number', number: '014-x15' },
      { kind: 'number', number: 'i34-i35' },
      { kind: 'title', title: 'One' },
      { kind: 'sessionId', sessionId: '' },
    ].map(selector)
    for (const answer of refused)
      expect(answer).toMatchObject({ ok: false, error: { code: 'invalid-request' } })

    // The allocated shapes, the custom ones, and the fork pair of each. `0012` and `014-0015` are
    // here because a title holds `\d{3,}` on both sides: a project past its 999th session draws a
    // number this selector refused to name until the two rules became one.
    for (const number of ['014', '0012', '014-015', '014-0015', 'i34', 'pr1200', 'i34-015'])
      expect(selector({ kind: 'number', number }).ok).toBe(true)
  })

  /*
   * The colour a session is born with, and the same bargain the model field made: exact keys, so a
   * target that predates the key refuses the whole create rather than dropping the colour. What is
   * pinned here is that the key is proved against the library's own closed set - not merely read as
   * a string and cast - and that a request without it parses exactly as it did before.
   */
  it('takes a session colour from the closed set and refuses any other name', () => {
    const withColor = RemoteControlRequestValidation.parse(RemoteControlRequestValidationTest.create({
      spec: { ...RemoteControlRequestValidationTest.shell, color: 'magenta' },
    }))
    const withoutColor = RemoteControlRequestValidation.parse(RemoteControlRequestValidationTest.create({
      spec: RemoteControlRequestValidationTest.shell,
    }))

    expect(withColor).toMatchObject({ ok: true, request: { body: { spec: { color: 'magenta' } } } })
    expect(withoutColor).toMatchObject({ ok: true })
    if (!withoutColor.ok) throw new Error('The fixture must parse')
    expect(withoutColor.request.body).toEqual({ spec: RemoteControlRequestValidationTest.shell })

    for (const color of ['chartreuse', 'MAGENTA', '#ff00ff', '', 7, null])
      expect(RemoteControlRequestValidation.parse(RemoteControlRequestValidationTest.create({
        spec: { ...RemoteControlRequestValidationTest.shell, color },
      }))).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
  })

  /*
   * The number a create BRINGS, which is a different grammar from the one a selector says: selecting
   * matches whatever is in the slot, `014` included, while bringing one may only be the custom shape
   * - an allocated number is the answering computer's to hand out. Exact keys again, so a target
   * that predates the field refuses the whole create rather than silently dropping the number.
   */
  it('takes a custom number on a create and refuses every other shape', () => {
    const withNumber = RemoteControlRequestValidation.parse(RemoteControlRequestValidationTest.create({
      spec: { ...RemoteControlRequestValidationTest.shell, number: 'i34' },
    }))

    expect(withNumber).toMatchObject({ ok: true, request: { body: { spec: { number: 'i34' } } } })
    for (const number of ['014', '014-015', 'hotfix', 'i1234567', 'I34 ', '', 34, null])
      expect(RemoteControlRequestValidation.parse(RemoteControlRequestValidationTest.create({
        spec: { ...RemoteControlRequestValidationTest.shell, number },
      }))).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
  })

  /*
   * The group is a key of the BODY rather than of the spec: the session manager stores no group, the
   * client does. What is pinned here is that the section is asked for beside the create rather than
   * inside the thing that describes the session, and how far this validator can go - to the SHAPE of
   * the id and no further, because which sections exist is a thing the target's owner edits.
   */
  it('takes a well-formed group id beside the create and refuses one no computer could have', () => {
    const withGroup = RemoteControlRequestValidation.parse(RemoteControlRequestValidationTest.create({
      spec: RemoteControlRequestValidationTest.shell,
      group: 'automation',
    }))
    const withoutGroup = RemoteControlRequestValidation.parse(RemoteControlRequestValidationTest.create({
      spec: RemoteControlRequestValidationTest.shell,
    }))

    expect(withGroup).toMatchObject({ ok: true, request: { body: { group: 'automation' } } })
    expect(withoutGroup).toMatchObject({ ok: true })
    if (!withoutGroup.ok) throw new Error('The fixture must parse')
    expect(withoutGroup.request.body).toEqual({ spec: RemoteControlRequestValidationTest.shell })

    for (const group of ['Automation', 'needs help', '-waiting', '', 7, null])
      expect(RemoteControlRequestValidation.parse(RemoteControlRequestValidationTest.create({
        spec: RemoteControlRequestValidationTest.shell,
        group,
      }))).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    expect(RemoteControlRequestValidation.parse(RemoteControlRequestValidationTest.create({
      spec: { ...RemoteControlRequestValidationTest.shell, group: 'automation' },
    }))).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    // A well-formed id nothing here has heard of parses, and that is the point: the sections are
    // the TARGET's, a person edits them, and a list of them here would be somebody else's list.
    expect(RemoteControlRequestValidation.parse(RemoteControlRequestValidationTest.create({
      spec: RemoteControlRequestValidationTest.shell,
      group: 'invented-yesterday',
    }))).toMatchObject({ ok: true, request: { body: { group: 'invented-yesterday' } } })
  })

  /*
   * The two mutations that repaint a session that already exists. Both REQUIRE a name: a create
   * naming no colour leaves the session unpainted, while a repaint naming none is a request that
   * says nothing. Both are mutations, so a missing operationId is refused, which is what makes the
   * same repaint sent twice one repaint.
   *
   * What each one PROVES differs, and that is not an oversight. A colour comes from a fixed palette
   * and an unknown one dies here. A group is a section a person made on the computer that will
   * answer, so what dies here is only an id no computer could have, and `no-such-group` travels.
   */
  it('requires a named colour and group when the session already exists', () => {
    const session = { kind: 'sessionId', sessionId: 'session-1' }
    const color = RemoteControlRequestValidation.parse(
      RemoteControlRequestValidationTest.of('sessions.color', { session, color: 'cyan' }))
    const group = RemoteControlRequestValidation.parse(
      RemoteControlRequestValidationTest.of('sessions.group', { session, group: 'waiting' }))

    expect(color).toMatchObject({
      ok: true,
      request: { operationId: 'operation-1', body: { session, color: 'cyan' } },
    })
    expect(group).toMatchObject({
      ok: true,
      request: { operationId: 'operation-1', body: { session, group: 'waiting' } },
    })
    expect(RemoteControlRequestValidation.isMutating('sessions.color')).toBe(true)
    expect(RemoteControlRequestValidation.isMutating('sessions.group')).toBe(true)

    const refused = [
      RemoteControlRequestValidationTest.of('sessions.color', { session }),
      RemoteControlRequestValidationTest.of('sessions.group', { session }),
      RemoteControlRequestValidationTest.of('sessions.color', { session, color: 'chartreuse' }),
      RemoteControlRequestValidationTest.of('sessions.group', { session, group: 'Waiting Room' }),
      // Each carries its own name and nothing beside it, and neither works without a session.
      RemoteControlRequestValidationTest.of('sessions.group', { session, group: 'waiting', color: 'cyan' }),
      RemoteControlRequestValidationTest.of('sessions.color', { color: 'cyan' }),
      RemoteControlRequestValidationTest.of('sessions.color', { session, color: 'cyan' }, null),
    ]
    for (const request of refused)
      expect(RemoteControlRequestValidation.parse(request))
        .toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    expect(RemoteControlRequestValidation.parse(
      RemoteControlRequestValidationTest.of('sessions.group', { session, group: 'no-such-group' }),
    )).toMatchObject({ ok: true, request: { body: { group: 'no-such-group' } } })
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
    return RemoteControlRequestValidationTest.of('sessions.create', body)
  }

  static of(
    operation: string,
    body: Record<string, unknown>,
    operationId: string | null = 'operation-1',
  ): Record<string, unknown> {
    return {
      protocol: RemoteControlConst.protocol,
      requestId: 'request-1',
      operation,
      ...(operationId === null ? {} : { operationId }),
      body,
    }
  }
}
