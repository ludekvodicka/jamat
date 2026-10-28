import { protocol } from 'electron'
import type { FileMediaSource } from './fileMediaSource'
import { FileViewerProtocolUrl } from '../../shared/fileViewerProtocol'

interface FileByteRange {
  start: number
  end: number
}

export class FileViewerProtocol {
  static registerScheme(): void {
    protocol.registerSchemesAsPrivileged([{
      scheme: FileViewerProtocolUrl.scheme,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
      },
    }])
  }

  private readonly source: FileMediaSource

  constructor(source: FileMediaSource) { this.source = source }

  initialize(): void {
    protocol.handle(FileViewerProtocolUrl.scheme, (request) => this.handle(request))
  }

  private async handle(request: Request): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } })
    const url = new URL(request.url)
    if (url.hostname !== 'resource') return new Response(null, { status: 404 })
    const segments = url.pathname.split('/').filter(Boolean)
    if (segments.length !== 1) return new Response(null, { status: 404 })
    let resourceId: string
    try { resourceId = decodeURIComponent(segments[0]!) }
    catch { return new Response(null, { status: 400 }) }
    const resource = await this.source.metadata(resourceId)
    if (resource.kind === 'missing') return new Response(null, { status: 404 })
    else if (resource.kind === 'changed') return new Response(null, { status: 409 })
    else if (resource.kind !== 'ready') throw new Error(`Unknown media metadata: ${JSON.stringify(resource)}`)
    const rangeHeader = request.headers.get('range')
    const range = rangeHeader === null ? null : FileViewerProtocol.range(rangeHeader, resource.size)
    if (rangeHeader !== null && range === null)
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${resource.size}` },
      })
    const start = range?.start ?? 0
    const end = range?.end ?? Math.max(0, resource.size - 1)
    const length = resource.size === 0 ? 0 : end - start + 1
    const headers = new Headers({
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
      'Content-Length': String(length),
      'Content-Type': resource.mimeType,
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'X-Content-Type-Options': 'nosniff',
    })
    if (range !== null) headers.set('Content-Range', `bytes ${start}-${end}/${resource.size}`)
    if (request.method === 'HEAD' || resource.size === 0)
      return new Response(null, { status: range === null ? 200 : 206, headers })
    const controller = new AbortController()
    const abort = (): void => controller.abort(request.signal.reason)
    if (request.signal.aborted) abort()
    else request.signal.addEventListener('abort', abort, { once: true })
    let offset = start
    const source = this.source
    const body = new ReadableStream<Uint8Array>({
      async pull(stream) {
        try {
          controller.signal.throwIfAborted()
          const size = Math.min(64 * 1024, end - offset + 1)
          const bytes = await source.read(resourceId, resource.version, offset, size, controller.signal)
          controller.signal.throwIfAborted()
          if (bytes.length === 0 || bytes.length > size) throw new Error('Invalid media byte range')
          offset += bytes.length
          stream.enqueue(bytes)
          if (offset > end) { request.signal.removeEventListener('abort', abort); stream.close() }
        } catch (error) { request.signal.removeEventListener('abort', abort); controller.abort(); stream.error(error) }
      },
      cancel() { controller.abort(); request.signal.removeEventListener('abort', abort) },
    }, { highWaterMark: 0 })
    return new Response(body, {
      status: range === null ? 200 : 206,
      headers,
    })
  }

  private static range(header: string, size: number): FileByteRange | null {
    if (size === 0 || !header.startsWith('bytes=') || header.includes(',')) return null
    const match = /^bytes=(\d*)-(\d*)$/.exec(header)
    if (!match) return null
    const startText = match[1]!
    const endText = match[2]!
    if (!startText && !endText) return null
    if (!startText) {
      const suffix = Number(endText)
      if (!Number.isSafeInteger(suffix) || suffix <= 0) return null
      return { start: Math.max(0, size - suffix), end: size - 1 }
    }
    const start = Number(startText)
    if (!Number.isSafeInteger(start) || start < 0 || start >= size) return null
    const requestedEnd = endText ? Number(endText) : size - 1
    if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start) return null
    return { start, end: Math.min(requestedEnd, size - 1) }
  }
}
