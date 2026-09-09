import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'

import type { RuntimeLaunchSpec } from '../wire/hostWire.js'
import { SessionError } from './sessionError.js'

/**
 * Request shape checks and the canonical digest used for create/replace replay. Split out of
 * SessionManager because none of it touches session state: it is the only part of the manager that
 * can be tested without a queue, a store and a terminal standing behind it.
 */
export class SessionRequestValidation {
  private static readonly runtimeIdPatternConst = /^[a-zA-Z0-9._:-]{1,128}$/
  private static readonly operationIdPatternConst = /^[a-zA-Z0-9._:-]{1,200}$/

  static validateRuntimeId(value: unknown): asserts value is string {
    if (typeof value !== 'string'
      || !SessionRequestValidation.runtimeIdPatternConst.test(value))
      throw new SessionError('invalid-request', 'runtimeSessionId has an invalid format')
  }

  static validateOperationId(value: unknown): asserts value is string {
    if (typeof value !== 'string'
      || !SessionRequestValidation.operationIdPatternConst.test(value))
      throw new SessionError('invalid-request', 'operationId has an invalid format')
  }

  /**
   * `env` must be the COMPLETE final child environment. The Host contributes nothing of its own, so
   * an incomplete map here becomes a child running without the variables its caller assumed.
   */
  static validateLaunch(launch: RuntimeLaunchSpec): void {
    if (!launch || typeof launch !== 'object')
      throw new SessionError('invalid-request', 'launch is required')
    if (typeof launch.command !== 'string' || !launch.command)
      throw new SessionError('invalid-request', 'launch.command is required')
    if (!Array.isArray(launch.args) || !launch.args.every((value) => typeof value === 'string'))
      throw new SessionError('invalid-request', 'launch.args must be a string array')
    if (typeof launch.cwd !== 'string' || !existsSync(launch.cwd))
      throw new SessionError('invalid-request', 'launch.cwd must be an existing directory')
    if (!launch.env
      || typeof launch.env !== 'object'
      || Array.isArray(launch.env)
      || !Object.values(launch.env).every((value) => typeof value === 'string'))
      throw new SessionError(
        'invalid-request',
        'launch.env must be the complete string environment',
      )
    if (!Number.isInteger(launch.cols) || launch.cols < 1 || launch.cols > 500)
      throw new SessionError('invalid-request', 'launch.cols must be an integer 1..500')
    if (!Number.isInteger(launch.rows) || launch.rows < 1 || launch.rows > 200)
      throw new SessionError('invalid-request', 'launch.rows must be an integer 1..200')
  }

  /**
   * The digest a replay is matched against. `controllerLeaseId` is omitted by the caller, so a retry
   * that legitimately carries a renewed lease still matches its original request.
   */
  static requestKey(value: object, omitted: string[] = []): string {
    return createHash('sha256').update(SessionRequestValidation.canonicalJson(Object.fromEntries(
      Object.entries(value).filter(([key]) => !omitted.includes(key)),
    ))).digest('hex')
  }

  /** Key order and `undefined` must not change the digest, or an identical retry looks different. */
  static canonicalJson(value: unknown): string {
    if (value === null || typeof value !== 'object')
      return JSON.stringify(value) ?? 'null'
    if (Array.isArray(value))
      return `[${value.map(SessionRequestValidation.canonicalJson).join(',')}]`
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${SessionRequestValidation.canonicalJson(item)}`)
      .join(',')}}`
  }
}
