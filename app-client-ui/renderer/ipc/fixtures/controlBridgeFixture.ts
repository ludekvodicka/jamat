import type {
  RemoteControlAnswer,
  RemoteControlStepResult,
} from '../../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type { AppClientUiBridge, IpcResult } from '../../../shared/appClientUiIpc'

type ControlHandler = (body: unknown) => RemoteControlStepResult<unknown> | Promise<RemoteControlStepResult<unknown>>

/**
 * A stand-in for `window.appClient.control`: each operation a test names answers with the step it is
 * given, every call is recorded, and an operation nobody stubbed fails the channel with its name.
 */
export class ControlBridgeFixture {
  readonly calls: { operation: string; body: unknown }[] = []
  private readonly handlers = new Map<string, ControlHandler>()
  private readonly channelErrors = new Map<string, string>()

  on(operation: string, answer: ControlHandler | RemoteControlStepResult<unknown>): this {
    this.handlers.set(operation, typeof answer === 'function' ? answer : () => answer)
    return this
  }

  /** The channel itself fails for this operation: the call never reached the main process. */
  failChannel(operation: string, error: string): this {
    this.channelErrors.set(operation, error)
    return this
  }

  /** Calls of one operation, bodies only. */
  bodiesOf(operation: string): unknown[] {
    return this.calls.filter((call) => call.operation === operation).map((call) => call.body)
  }

  bridge(): AppClientUiBridge['control'] {
    return {
      call: async (operation: string, body: unknown): Promise<IpcResult<RemoteControlAnswer>> => {
        this.calls.push({ operation, body })
        const channelError = this.channelErrors.get(operation)
        if (channelError !== undefined) return { ok: false, error: channelError }
        const handler = this.handlers.get(operation)
        if (handler === undefined) return { ok: false, error: `No stub for ${operation}` }
        const step = await handler(body)
        const ids = { protocol: 'appjamat-v3-control.v1' as const, requestId: 'request', operation, operationId: null }
        return { ok: true, value: step.ok ? { ...ids, ok: true, value: step.value } : { ...ids, ok: false, error: step.error } }
      },
    }
  }

  /** A library result as the registry hands it on: the value, or the refusal with its own code. */
  static library(result: { ok: true; value?: unknown } | { ok: false; code: string; detail: string; [field: string]: unknown }):
  RemoteControlStepResult<unknown> {
    if (result.ok) return { ok: true, value: 'value' in result ? result.value : {} }
    const { ok: _ok, code, detail, ...fields } = result
    return { ok: false, error: { code: 'operation-failed', detail, data: { sourceCode: code, ...fields } } }
  }

  /**
   * What the channel would carry for a library answer a test already holds in the old bridge shape:
   * a channel failure stays one, a library result becomes the registry's envelope.
   */
  static answerOf(
    operation: string,
    answer: IpcResult<{ ok: true; value?: unknown } | { ok: false; code: string; detail: string; [field: string]: unknown }>,
  ): IpcResult<RemoteControlAnswer> {
    if (!answer.ok) return answer
    const step = ControlBridgeFixture.library(answer.value)
    const ids = { protocol: 'appjamat-v3-control.v1' as const, requestId: 'request', operation, operationId: null }
    return { ok: true, value: step.ok ? { ...ids, ok: true, value: step.value } : { ...ids, ok: false, error: step.error } }
  }

  /** The same for a plain value: a channel failure stays one, the value becomes the envelope's. */
  static valueOf(operation: string, answer: IpcResult<unknown>): IpcResult<RemoteControlAnswer> {
    if (!answer.ok) return answer
    return { ok: true, value: { protocol: 'appjamat-v3-control.v1', requestId: 'request', operation, operationId: null, ok: true, value: answer.value } }
  }

  /**
   * A control channel that hands each operation to a function answering the way the window would
   * have received the library's answer: `library` for a result with its own refusal, `value` for a
   * plain read. Looked up per call, so a test can swap a function after the bridge is installed.
   */
  static routes(routes: Record<string, {
    library?: (body: any) => Promise<IpcResult<any>>
    value?: (body: any) => Promise<IpcResult<unknown>>
  }>): AppClientUiBridge['control'] {
    return {
      call: async (operation: string, body: unknown): Promise<IpcResult<RemoteControlAnswer>> => {
        const route = routes[operation]
        if (route?.library !== undefined) return ControlBridgeFixture.answerOf(operation, await route.library(body))
        if (route?.value !== undefined) return ControlBridgeFixture.valueOf(operation, await route.value(body))
        return { ok: false, error: `No stub for ${operation}` }
      },
    }
  }

  static done(): RemoteControlStepResult<unknown> {
    return { ok: true, value: {} }
  }
}
