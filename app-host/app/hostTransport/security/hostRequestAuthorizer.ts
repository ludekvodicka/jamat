import { timingSafeEqual } from 'node:crypto'
import type http from 'node:http'

import { HostOperationError } from '../hostOperationError.js'

export class HostRequestAuthorizer {
  private static readonly authLogIntervalMsConst = 5_000
  private authFailures = 0
  private lastAuthLogAt = 0

  constructor(
    private readonly token: string,
    private readonly log: (message: string) => void,
  ) {}

  authorize(request: http.IncomingMessage, port: number): HostOperationError | null {
    if (typeof request.headers.origin === 'string' && request.headers.origin.length > 0)
      return this.denied(new HostOperationError(403, 'forbidden'), request)
    if (!HostRequestAuthorizer.hostHeaderMatches(request, port))
      return this.denied(new HostOperationError(403, 'forbidden'), request)
    if (!HostRequestAuthorizer.tokenMatches(HostRequestAuthorizer.bearer(request), this.token))
      return this.denied(new HostOperationError(401, 'unauthorized'), request)
    return null
  }

  // Rate-limited so a hammering client cannot turn the log into the denial-of-service it is attempting.
  private denied(error: HostOperationError, request: http.IncomingMessage): HostOperationError {
    this.authFailures++
    const now = Date.now()
    if (now - this.lastAuthLogAt >= HostRequestAuthorizer.authLogIntervalMsConst) {
      this.lastAuthLogAt = now
      this.log(
        `WARN ${error.status} ${request.method ?? '?'} ${request.url ?? '?'} `
        + `(${this.authFailures} rejected so far)`,
      )
    }
    return error
  }

  private static bearer(request: http.IncomingMessage): string {
    const authorization = request.headers.authorization
    if (typeof authorization !== 'string') return ''
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim())
    return match ? match[1] : ''
  }

  private static tokenMatches(supplied: string, expected: string): boolean {
    const actualBuffer = Buffer.from(supplied)
    const expectedBuffer = Buffer.from(expected)
    return actualBuffer.length === expectedBuffer.length
      && timingSafeEqual(actualBuffer, expectedBuffer)
  }

  private static hostHeaderMatches(request: http.IncomingMessage, port: number): boolean {
    const host = (request.headers.host ?? '').toLowerCase()
    return host === `127.0.0.1:${port}` || host === `localhost:${port}`
  }
}
