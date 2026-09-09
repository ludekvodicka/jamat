import type {
  RemoteControlError,
  RemoteControlResponse,
  RemoteControlSocketResponse,
} from '../remoteControlApi.types'
import { RemoteControlConst } from '../remoteControlProtocol'
import { JsonShape } from '../../shared/jsonShape'

/**
 * What an answer must look like before anything routes on it.
 *
 * Both sides of the wire need this and for different reasons: the CLI reads answers off a loopback
 * server it started itself, and the peer channel reads them off ANOTHER COMPUTER, which is the one
 * that is not trusted. Until 2026-08-23 the peer channel had no check at all - the cipher's guard
 * said "this is an object" while the type said it was a validated union, so a paired peer could
 * answer with any shape and the channel would hand it on as a `RemoteControlResponse`.
 *
 * The envelope is what is checked, because the envelope is what routing depends on. A body travels
 * as data: whoever reads one validates it there (the sessions snapshot is the one that does).
 */
export class RemoteControlResponseValidation {
  private static readonly transcriptNoneCodesConst = [
    'not-agent',
    'native-session-id-pending',
    'transcript-not-found',
    'no-messages-in-scanned-tail',
    'transcript-unreadable',
  ] as const
  private static readonly frameTypesConst = [
    'terminal.attached',
    'terminal.snapshot',
    'terminal.data',
    'terminal.delta',
    'terminal.resize',
    'terminal.exit',
    'terminal.status',
  ] as const

  static control(input: unknown): RemoteControlResponse | null {
    const value = RemoteControlResponseValidation.envelope(input)
    if (value === null
      || !RemoteControlResponseValidation.optionalText(value.requestId)
      || !RemoteControlResponseValidation.optionalText(value.operation)
      || !RemoteControlResponseValidation.optionalText(value.operationId)
      || !RemoteControlResponseValidation.outcome(value))
      return null
    if (value.operation === 'sessions.transcript'
      && value.ok === true
      && !RemoteControlResponseValidation.transcript(value.value))
      return null
    return input as RemoteControlResponse
  }

  static socket(input: unknown): RemoteControlSocketResponse | null {
    const value = RemoteControlResponseValidation.envelope(input)
    if (value === null) return null
    if (value.type === 'response') {
      if (!RemoteControlResponseValidation.optionalText(value.requestId)
        || !RemoteControlResponseValidation.socketOperation(value.operation)
        || !RemoteControlResponseValidation.optionalText(value.operationId)
        || !RemoteControlResponseValidation.outcome(value))
        return null
    } else if (value.type === 'event') {
      const event = JsonShape.record(value.event)
      if (event === null
        || !Number.isSafeInteger(event.revision)
        || (event.kind !== 'sessions.changed' && event.kind !== 'tabs.changed')
        || !Number.isSafeInteger(event.at))
        return null
    } else if (value.type === 'terminal.frame') {
      const frame = JsonShape.record(value.frame)
      if (typeof value.attachId !== 'string'
        || value.terminalOutputUntrusted !== true
        || frame === null
        || !RemoteControlResponseValidation.frameType(frame.type))
        return null
    } else return null
    return input as RemoteControlSocketResponse
  }

  static error(input: unknown): input is RemoteControlError {
    const value = JsonShape.record(input)
    if (value === null) return false
    return typeof value.detail === 'string'
      && typeof value.code === 'string'
      && (RemoteControlConst.errorCodes as readonly string[]).includes(value.code)
  }

  static transcript(input: unknown): boolean {
    const value = JsonShape.record(input)
    if (value === null
      || !RemoteControlResponseValidation.exactKeys(
        value,
        ['sessionId', 'transcriptContentUntrusted', 'reading'],
      )
      || typeof value.sessionId !== 'string'
      || value.sessionId.length === 0
      || value.transcriptContentUntrusted !== true)
      return false
    const reading = JsonShape.record(value.reading)
    if (reading === null) return false
    if (reading.kind === 'none')
      return RemoteControlResponseValidation.exactKeys(reading, ['kind', 'code', 'reason'])
        && typeof reading.code === 'string'
        && (RemoteControlResponseValidation.transcriptNoneCodesConst as readonly string[])
          .includes(reading.code)
        && typeof reading.reason === 'string'
    if (reading.kind === 'messages') {
      const bounds = JsonShape.record(reading.bounds)
      if (!RemoteControlResponseValidation.exactKeys(
        reading,
        ['kind', 'messages', 'bounds', 'earlierContentOmitted'],
      )
        || !Array.isArray(reading.messages)
        || bounds === null
        || !RemoteControlResponseValidation.exactKeys(
          bounds,
          ['maxMessages', 'maxCharactersPerMessage', 'scannedBytes'],
        )
        || !Number.isSafeInteger(bounds.maxMessages)
        || !Number.isSafeInteger(bounds.maxCharactersPerMessage)
        || !Number.isSafeInteger(bounds.scannedBytes)
        || (bounds.maxMessages as number) < 0
        || (bounds.maxCharactersPerMessage as number) < 0
        || (bounds.scannedBytes as number) < 0
        || reading.messages.length > (bounds.maxMessages as number)
        || typeof reading.earlierContentOmitted !== 'boolean')
        return false
      return reading.messages.every((raw) => {
        const message = JsonShape.record(raw)
        return message !== null
          && RemoteControlResponseValidation.exactKeys(
            message,
            ['role', 'text', 'at', 'textTruncated'],
          )
          && (message.role === 'user' || message.role === 'assistant')
          && typeof message.text === 'string'
          && message.text.length <= (bounds.maxCharactersPerMessage as number)
          && (message.at === null || typeof message.at === 'number' && Number.isFinite(message.at))
          && typeof message.textTruncated === 'boolean'
      })
    }
    return false
  }

  private static envelope(input: unknown): Record<string, unknown> | null {
    const value = JsonShape.record(input)
    if (value === null || value.protocol !== RemoteControlConst.protocol) return null
    return value
  }

  /** `ok: true` must carry a `value` field, even an undefined one; `ok: false` must carry an error. */
  private static outcome(value: Record<string, unknown>): boolean {
    if (value.ok === true) return Object.hasOwn(value, 'value')
    if (value.ok === false) return RemoteControlResponseValidation.error(value.error)
    return false
  }

  private static socketOperation(input: unknown): boolean {
    return input === null
      || (typeof input === 'string'
        && (RemoteControlConst.socketOperations as readonly string[]).includes(input))
  }

  /**
   * The frame itself travels as data, exactly like the frames the Host sends: only the tag is read
   * here, and the terminal draws the rest under `terminalOutputUntrusted`.
   */
  private static frameType(input: unknown): boolean {
    return typeof input === 'string'
      && (RemoteControlResponseValidation.frameTypesConst as readonly string[]).includes(input)
  }

  private static optionalText(input: unknown): boolean {
    return input === null || typeof input === 'string'
  }

  private static exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    const actual = Object.keys(value)
    return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  }

}
