import type { RemoteControlError, RemoteControlStepResult } from './remoteControlApi.types'

/** A library result: a value, or a refusal with its own code, its sentence and any fields beside them. */
export type RemoteControlLibraryResult =
  | { ok: true; value?: unknown }
  | { ok: false; code: string; detail: string }

/**
 * A library result as an operation's answer. The refusal keeps the library's code as `sourceCode`
 * and every field beside it in `data`, so a caller that knows the library reads the same refusal it
 * would have read in-process, and one that does not reads the protocol code. A result with no value
 * answers `{}`.
 */
export class RemoteControlOutcome {
  static of<T>(
    result: RemoteControlLibraryResult,
    codeOf: (code: string) => RemoteControlError['code'] = RemoteControlOutcome.defaultCodeOf,
  ): RemoteControlStepResult<T> {
    if (result.ok) return { ok: true, value: ('value' in result ? result.value : {}) as T }
    const { ok: _ok, code, detail, ...fields } = result as { ok: false; code: string; detail: string; [field: string]: unknown }
    return { ok: false, error: { code: codeOf(code), detail, data: { sourceCode: code, ...fields } } }
  }

  /** `not-found` and the `*-not-found` codes are the protocol's own; everything else failed. */
  static defaultCodeOf(code: string): RemoteControlError['code'] {
    return code === 'not-found' || code.endsWith('-not-found') ? 'not-found' : 'operation-failed'
  }
}
