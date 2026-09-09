import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'

import { protocol } from 'electron'

import {
  FileContentReader,
} from '../../../lib-orchestrator/fileViewer/content/fileContentReader'
import type { FileViewer } from '../../../lib-orchestrator/fileViewer/fileViewer'
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

  constructor(private readonly viewer: FileViewer) {}

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
    const resource = await this.viewer.resourceAccess(resourceId)
    if (resource === null) return new Response(null, { status: 404 })
    let info
    try { info = await stat(resource.path) }
    catch { return new Response(null, { status: 404 }) }
    if (!info.isFile()
      || FileContentReader.versionOf(info.size, info.mtimeMs) !== resource.contentVersion
      || info.size !== resource.size)
      return new Response(null, { status: 409 })
    const rangeHeader = request.headers.get('range')
    const range = rangeHeader === null ? null : FileViewerProtocol.range(rangeHeader, info.size)
    if (rangeHeader !== null && range === null)
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${info.size}` },
      })
    const start = range?.start ?? 0
    const end = range?.end ?? Math.max(0, info.size - 1)
    const length = info.size === 0 ? 0 : end - start + 1
    const headers = new Headers({
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
      'Content-Length': String(length),
      'Content-Type': resource.mimeType,
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'X-Content-Type-Options': 'nosniff',
    })
    if (range !== null) headers.set('Content-Range', `bytes ${start}-${end}/${info.size}`)
    if (request.method === 'HEAD' || info.size === 0)
      return new Response(null, { status: range === null ? 200 : 206, headers })
    const body = Readable.toWeb(createReadStream(resource.path, { start, end }))
    return new Response(body as ReadableStream<Uint8Array>, {
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
