import type http from 'node:http'

import { HostWireConst } from '../../wire/hostWire.js'
import { HostOperationError } from '../hostOperationError.js'

export class HostHttpBodyReader {
  private static readonly drainCeilingBytesConst = HostWireConst.maxOpBodyBytes * 8

  static readJson(request: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let size = 0
      let tooLarge = false
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size <= HostWireConst.maxOpBodyBytes) {
          chunks.push(chunk)
          return
        }
        tooLarge = true
        chunks.length = 0
        // Read on past the limit so a normal client still gets its 413 answer, but stop draining a
        // sender that keeps going: past the ceiling the socket is torn down instead.
        if (size > HostHttpBodyReader.drainCeilingBytesConst) {
          reject(new HostOperationError(413, 'body too large'))
          request.destroy()
        }
      })
      request.on('end', () => {
        if (tooLarge) {
          reject(new HostOperationError(413, 'body too large'))
          return
        }
        const raw = Buffer.concat(chunks).toString('utf-8').trim()
        if (!raw) {
          resolve({})
          return
        }
        try { resolve(JSON.parse(raw)) }
        catch { reject(new HostOperationError(400, 'invalid JSON body')) }
      })
      request.on('error', () => reject(new HostOperationError(400, 'request stream error')))
    })
  }
}
