import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type { RemoteControlCallerKind } from './remoteControlApi.types'
import { RemoteControlConst } from './remoteControlProtocol'
import { type RemoteControlCallContext, RemoteControlRegistry, type RemoteControlRunContext } from './remoteControlRegistry'

describe('lib-orchestrator/remoteControl/remoteControlRegistry', () => {
  function registry(now = (): number => 1_000): {
    registry: RemoteControlRegistry
    errors: string[]
    written: { operation: string; callerKind: RemoteControlCallerKind; body: unknown }[]
    runs: unknown[]
  } {
    const errors: string[] = []
    const written: { operation: string; callerKind: RemoteControlCallerKind; body: unknown }[] = []
    const runs: unknown[] = []
    const found = new RemoteControlRegistry({
      onError: (message) => errors.push(message),
      onWritten: (operation, context, body) => written.push({ operation, callerKind: context.callerKind, body }),
      now,
    })
    found.register('notes.read', {
      kind: 'read',
      description: 'Read a note.',
      input: z.strictObject({ id: z.string().min(1) }),
      run: async (body) => {
        runs.push(body)
        return { ok: true, value: { id: body.id, text: 'hello' } }
      },
    })
    found.register('notes.write', {
      kind: 'write',
      description: 'Write a note.',
      input: z.strictObject({ id: z.string(), text: z.string().max(5, { error: 'is too long' }) }),
      run: async (body) => {
        runs.push(body)
        if (body.id === 'refused') return { ok: false, error: { code: 'conflict', detail: 'taken', data: { sourceCode: 'note-taken' } } }
        if (body.id === 'thrown') throw new Error('secret detail')
        return { ok: true, value: {} }
      },
    })
    return { registry: found, errors, written, runs }
  }

  function context(callerKind: RemoteControlCallerKind = 'local-cli', allowed?: readonly string[]): RemoteControlCallContext {
    return { callerId: `${callerKind}-1`, callerKind, allowedOperations: allowed ?? ['notes.read', 'notes.write'] }
  }

  function request(operation: string, body: unknown, operationId?: string): unknown {
    return {
      protocol: RemoteControlConst.protocol,
      requestId: `request-${operation}`,
      operation,
      ...(operationId === undefined ? {} : { operationId }),
      body,
    }
  }

  it('answers a read and a write through the same envelope, and logs the write as written', async () => {
    const found = registry()
    await expect(found.registry.execute(request('notes.read', { id: 'a' }), context())).resolves.toEqual({
      protocol: RemoteControlConst.protocol,
      requestId: 'request-notes.read',
      operation: 'notes.read',
      operationId: null,
      ok: true,
      value: { id: 'a', text: 'hello' },
    })
    await expect(found.registry.execute(request('notes.write', { id: 'a', text: 'x' }, 'op-1'), context('window')))
      .resolves.toMatchObject({ ok: true, operationId: 'op-1', value: {} })
    expect(found.written).toEqual([{ operation: 'notes.write', callerKind: 'window', body: { id: 'a', text: 'x' } }])
  })

  it('names every wrong field with its path and runs nothing', async () => {
    const found = registry()
    await expect(found.registry.execute(request('notes.write', { id: 7, text: 'too long', extra: 1 }, 'op-2'), context()))
      .resolves.toMatchObject({
        ok: false,
        error: {
          code: 'invalid-request',
          detail: expect.stringMatching(/^id: .*; text: is too long; notes.write body: .*extra/),
        },
      })
    expect(found.runs).toEqual([])
  })

  it('keeps the envelope rules: a write needs an operation id, a read takes none, an unknown name is refused', async () => {
    const found = registry()
    await expect(found.registry.execute(request('notes.write', { id: 'a', text: 'x' }), context()))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-request', detail: 'operationId is required for notes.write' } })
    await expect(found.registry.execute(request('notes.read', { id: 'a' }, 'op-3'), context()))
      .resolves.toMatchObject({ ok: false, error: { detail: 'operationId is not allowed for notes.read' } })
    await expect(found.registry.execute(request('notes.erase', {}), context()))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-request', detail: 'Unknown operation: "notes.erase"' } })
  })

  it('hands a write handler the envelope operation id and a read handler null, beside the unchanged caller', async () => {
    const seen: RemoteControlRunContext[] = []
    const found = new RemoteControlRegistry({ onError: () => {} })
    found.register('notes.read', {
      kind: 'read',
      description: 'Read a note.',
      input: z.strictObject({}),
      run: async (_body, run) => {
        seen.push(run)
        return { ok: true, value: {} }
      },
    })
    found.register('notes.write', {
      kind: 'write',
      description: 'Write a note.',
      input: z.strictObject({}),
      run: async (_body, run) => {
        seen.push(run)
        return { ok: true, value: {} }
      },
    })
    const caller = context('remote-peer')
    await found.execute(request('notes.write', {}, 'op-id-1'), caller)
    await found.execute(request('notes.read', {}), caller)
    expect(seen).toEqual([{ ...caller, operationId: 'op-id-1' }, { ...caller, operationId: null }])
  })

  it('refuses an operation the caller was not granted, before it runs', async () => {
    const found = registry()
    await expect(found.registry.execute(request('notes.write', { id: 'a', text: 'x' }, 'op-4'), context('remote-peer', ['notes.read'])))
      .resolves.toMatchObject({ ok: false, error: { code: 'forbidden', detail: 'notes.write is not allowed for remote-peer' } })
    expect(found.runs).toEqual([])
  })

  it('replays a repeated write from its store and refuses an operation id reused for another body', async () => {
    const found = registry()
    await found.registry.execute(request('notes.write', { id: 'a', text: 'x' }, 'op-5'), context())
    await found.registry.execute(request('notes.write', { id: 'a', text: 'x' }, 'op-5'), context())
    expect(found.runs).toHaveLength(1)
    await expect(found.registry.execute(request('notes.write', { id: 'a', text: 'y' }, 'op-5'), context()))
      .resolves.toMatchObject({ ok: false, error: { code: 'conflict' } })
  })

  it('hides what a thrown operation said, reports it, and logs nothing as written', async () => {
    const found = registry()
    await expect(found.registry.execute(request('notes.write', { id: 'thrown', text: 'x' }, 'op-6'), context()))
      .resolves.toMatchObject({ ok: false, error: { code: 'operation-failed', detail: 'The operation failed unexpectedly' } })
    expect(found.errors).toEqual(['Remote control notes.write failed: secret detail'])
    expect(found.written).toEqual([])
  })

  it('logs every call with its caller, outcome, library code and duration, the latest 100', async () => {
    let clock = 1_000
    const found = registry(() => clock)
    await found.registry.execute(request('notes.write', { id: 'refused', text: 'x' }, 'op-7'), context('window'))
    clock = 1_250
    await found.registry.execute(request('notes.read', { id: 'b' }), context())
    expect(found.registry.latestCalls()).toEqual([
      { at: 1_000, operation: 'notes.write', callerKind: 'window', callerId: 'window-1', ok: false, code: 'conflict', sourceCode: 'note-taken', durationMs: 0 },
      { at: 1_250, operation: 'notes.read', callerKind: 'local-cli', callerId: 'local-cli-1', ok: true, code: null, sourceCode: null, durationMs: 0 },
    ])
    for (let index = 0; index < 120; index += 1)
      await found.registry.execute(request('notes.read', { id: `${index}` }), context())
    expect(found.registry.latestCalls()).toHaveLength(RemoteControlRegistry.callLogLimitConst)
  })

  it('lists a catalog with the JSON Schema of each body, sorted by name', () => {
    const catalog = registry().registry.catalog()
    expect(catalog.map((entry) => [entry.name, entry.kind])).toEqual([['notes.read', 'read'], ['notes.write', 'write']])
    expect(catalog[1]).toMatchObject({
      description: 'Write a note.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, text: { type: 'string', maxLength: 5 } },
        required: ['id', 'text'],
        additionalProperties: false,
      },
    })
  })

  it('refuses a second registration of a name and a name that is not <domain>.<verb>', () => {
    const found = registry().registry
    const spec = { kind: 'read' as const, description: '', input: z.strictObject({}), run: async () => ({ ok: true as const, value: {} }) }
    expect(() => found.register('notes.read', spec)).toThrow(/registered twice/)
    expect(() => found.register('notes', spec)).toThrow(/is not <domain>.<verb>/)
    expect(() => found.register('Notes.read', spec)).toThrow(/is not <domain>.<verb>/)
  })
})
