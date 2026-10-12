import { z } from 'zod'

import { ErrorText } from '../shared/errorText'
import type {
  RemoteControlAnswer,
  RemoteControlCallerKind,
  RemoteControlCallRecordDto,
  RemoteControlCatalogEntryDto,
  RemoteControlError,
  RemoteControlOperationKind,
  RemoteControlStepResult,
} from './remoteControlApi.types'
import { RemoteControlEnvelopeValidation } from './remoteControlEnvelopeValidation'
import { RemoteControlOperationStore } from './remoteControlOperationStore'
import { RemoteControlConst } from './remoteControlProtocol'
import { RemoteControlZod } from './remoteControlSchemas'

export interface RemoteControlCallContext {
  callerId: string
  callerKind: RemoteControlCallerKind
  allowedOperations: readonly string[]
}

/**
 * One operation: its name, whether it writes, a sentence for the catalog, the schema of its body and
 * the handler. The handler sees a body the schema already accepted.
 */
export interface RemoteControlOperationSpec<TBody, TValue> {
  kind: RemoteControlOperationKind
  description: string
  input: z.ZodType<TBody>
  run(body: TBody, context: RemoteControlCallContext): Promise<RemoteControlStepResult<TValue>>
}

export interface RemoteControlRegistryRequest {
  protocol: typeof RemoteControlConst.protocol
  requestId: string
  operation: string
  operationId?: string
  body: unknown
}

export type RemoteControlRegistryParse =
  | { ok: true; request: RemoteControlRegistryRequest }
  | { ok: false; requestId: string | null; operation: string | null; operationId: string | null; error: RemoteControlError }

export interface RemoteControlRegistryDeps {
  onError(message: string): void
  /** Every successful write, after its answer is composed: the activity log hears of it here. */
  onWritten?(operation: string, context: RemoteControlCallContext, body: unknown): void
  operationStore?: RemoteControlOperationStore
  now?(): number
}

/**
 * Every operation of the control API in one place, whoever calls it: the window over its one IPC
 * channel, the CLI and scripts over HTTP, a paired computer over the peer channel. Each call passes
 * the same envelope rules, the same schema, the same replay store for writes, and lands in the same
 * call log, so what the window can do and what a script can do cannot drift apart.
 *
 * It knows no operation by name. The library registers the protocol's, the client its own.
 */
export class RemoteControlRegistry {
  static readonly callLogLimitConst = 100
  private readonly specs = new Map<string, RemoteControlOperationSpec<unknown, unknown>>()
  private readonly catalogCache = new Map<string, RemoteControlCatalogEntryDto>()
  private readonly calls: RemoteControlCallRecordDto[] = []
  private readonly operationStore: RemoteControlOperationStore
  private readonly now: () => number

  constructor(private readonly deps: RemoteControlRegistryDeps) {
    this.operationStore = deps.operationStore ?? new RemoteControlOperationStore()
    this.now = deps.now ?? Date.now
  }

  register<TBody, TValue>(name: string, spec: RemoteControlOperationSpec<TBody, TValue>): void {
    if (this.specs.has(name)) throw new Error(`Operation ${name} is registered twice`)
    if (!/^[a-z][A-Za-z]*(\.[a-z][A-Za-z]*)+$/.test(name))
      throw new Error(`Operation name ${JSON.stringify(name)} is not <domain>.<verb>`)
    this.specs.set(name, spec as RemoteControlOperationSpec<unknown, unknown>)
  }

  /**
   * Registration against a typed map, so the schema, the handler and the map that a typed caller
   * compiles against agree: a handler answering another shape than the map's response does not compile.
   */
  registrar<TMap extends { [K in keyof TMap]: { request: unknown; response: unknown } }>(): <K extends keyof TMap & string>(
    name: K,
    spec: RemoteControlOperationSpec<TMap[K]['request'], TMap[K]['response']>,
  ) => void {
    return (name, spec) => this.register(name, spec)
  }

  names(): string[] {
    return [...this.specs.keys()]
  }

  has(name: string): boolean {
    return this.specs.has(name)
  }

  isWrite(name: string): boolean {
    return this.specs.get(name)?.kind === 'write'
  }

  catalog(): RemoteControlCatalogEntryDto[] {
    return this.names().sort().map((name) => this.catalogEntry(name))
  }

  latestCalls(): readonly RemoteControlCallRecordDto[] {
    return [...this.calls]
  }

  parse(input: unknown): RemoteControlRegistryParse {
    const envelope = RemoteControlEnvelopeValidation.parse<string>(input, {
      operations: this.names(),
      isMutating: (operation) => this.isWrite(operation),
    })
    if (!envelope.ok) return envelope
    const { requestId, operation, operationId } = envelope
    const spec = this.mustSpec(operation)
    const body = spec.input.safeParse(envelope.body)
    if (!body.success)
      return {
        ok: false,
        requestId,
        operation,
        operationId,
        error: { code: 'invalid-request', detail: RemoteControlZod.problemOf(body.error, operation) },
      }
    return {
      ok: true,
      request: {
        protocol: RemoteControlConst.protocol,
        requestId,
        operation,
        ...(operationId === null ? {} : { operationId }),
        body: body.data,
      },
    }
  }

  async execute(input: unknown, context: RemoteControlCallContext): Promise<RemoteControlAnswer> {
    const startedAt = this.now()
    const parsed = this.parse(input)
    if (!parsed.ok) {
      this.record(parsed.operation, context, startedAt, parsed.error)
      return RemoteControlRegistry.failure(parsed.requestId, parsed.operation, parsed.operationId, parsed.error)
    }
    const request = parsed.request
    const refusal = RemoteControlRegistry.refusalOf(request.operation, context)
    if (refusal !== null) {
      this.record(request.operation, context, startedAt, refusal)
      return RemoteControlRegistry.failure(request.requestId, request.operation, request.operationId ?? null, refusal)
    }
    const spec = this.mustSpec(request.operation)
    let result: RemoteControlStepResult<unknown>
    try {
      if (spec.kind === 'write') {
        const operationId = request.operationId
        if (operationId === undefined)
          throw new Error(`Mutation ${request.operation} passed validation without operationId`)
        const stored = await this.operationStore.runOrRefuse(
          context.callerId,
          operationId,
          JSON.stringify({ operation: request.operation, body: request.body }),
          () => spec.run(request.body, context),
        )
        result = stored.ok ? stored.value : stored
      } else result = await spec.run(request.body, context)
    } catch (error) {
      this.deps.onError(`Remote control ${request.operation} failed: ${ErrorText.of(error)}`)
      result = { ok: false, error: { code: 'operation-failed', detail: 'The operation failed unexpectedly' } }
    }
    this.record(request.operation, context, startedAt, result.ok ? null : result.error)
    if (!result.ok)
      return RemoteControlRegistry.failure(request.requestId, request.operation, request.operationId ?? null, result.error)
    if (spec.kind === 'write') this.deps.onWritten?.(request.operation, context, request.body)
    return {
      protocol: RemoteControlConst.protocol,
      requestId: request.requestId,
      operation: request.operation,
      operationId: request.operationId ?? null,
      ok: true,
      value: result.value,
    }
  }

  private catalogEntry(name: string): RemoteControlCatalogEntryDto {
    const cached = this.catalogCache.get(name)
    if (cached !== undefined) return cached
    const spec = this.mustSpec(name)
    const entry: RemoteControlCatalogEntryDto = {
      name,
      kind: spec.kind,
      description: spec.description,
      inputSchema: z.toJSONSchema(spec.input, { unrepresentable: 'any', io: 'input' }),
    }
    this.catalogCache.set(name, entry)
    return entry
  }

  private record(
    operation: string | null,
    context: RemoteControlCallContext,
    startedAt: number,
    error: RemoteControlError | null,
  ): void {
    const sourceCode = error?.data?.sourceCode
    this.calls.push({
      at: startedAt,
      operation,
      callerKind: context.callerKind,
      callerId: context.callerId,
      ok: error === null,
      code: error?.code ?? null,
      sourceCode: typeof sourceCode === 'string' ? sourceCode : null,
      durationMs: Math.max(0, this.now() - startedAt),
    })
    if (this.calls.length > RemoteControlRegistry.callLogLimitConst) this.calls.shift()
  }

  private mustSpec(name: string): RemoteControlOperationSpec<unknown, unknown> {
    const spec = this.specs.get(name)
    if (spec === undefined) throw new Error(`Operation ${name} passed validation without a registration`)
    return spec
  }

  private static refusalOf(operation: string, context: RemoteControlCallContext): RemoteControlError | null {
    if (context.callerId.length === 0) return { code: 'invalid-request', detail: 'callerId must not be empty' }
    if (!context.allowedOperations.includes(operation))
      return { code: 'forbidden', detail: `${operation} is not allowed for ${context.callerKind}` }
    return null
  }

  private static failure(
    requestId: string | null,
    operation: string | null,
    operationId: string | null,
    error: RemoteControlError,
  ): RemoteControlAnswer {
    return { protocol: RemoteControlConst.protocol, requestId, operation, operationId, ok: false, error }
  }
}
