import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { FileViewer } from '../../../lib-orchestrator/fileViewer/fileViewer'
import type {
  FileViewerGrantedFile,
} from '../../../lib-orchestrator/fileViewer/fileViewerApi.types'
import {
  FileContentReader,
} from '../../../lib-orchestrator/fileViewer/content/fileContentReader'
import { FileViewerProtocol } from './fileViewerProtocol'

const protocolMock = vi.hoisted(() => ({
  registrations: [] as unknown[],
  handler: null as ((request: Request) => Promise<Response>) | null,
}))

vi.mock('electron', () => ({
  protocol: {
    registerSchemesAsPrivileged: (value: unknown) => protocolMock.registrations.push(value),
    handle: (_scheme: string, handler: (request: Request) => Promise<Response>) => {
      protocolMock.handler = handler
    },
  },
}))

describe('app-client-ui/app/fileViewer/fileViewerProtocol', () => {
  let directory: string
  let resource: FileViewerGrantedFile

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'jamat-v3-file-protocol-'))
    const path = join(directory, 'media.bin')
    await writeFile(path, 'abcdefghij')
    const info = await stat(path)
    resource = {
      path,
      mimeType: 'application/octet-stream',
      size: info.size,
      // Minted the way the reader mints it. Written by hand here and in the protocol, the two
      // spellings would drift the moment `versionOf` gained an inode or a hash, and every
      // `jamat-file://resource/...` would answer 409 for a file nobody touched.
      contentVersion: FileContentReader.versionOf(info.size, info.mtimeMs),
    }
    protocolMock.registrations = []
    protocolMock.handler = null
  })

  afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

  function initialize(): (request: Request) => Promise<Response> {
    const viewer = {
      resourceAccess: (resourceId: string) => Promise.resolve(
        resourceId === 'token' ? resource : null,
      ),
    } as unknown as FileViewer
    new FileViewerProtocol(viewer).initialize()
    if (!protocolMock.handler) throw new Error('Protocol handler was not installed')
    return protocolMock.handler
  }

  it('registers a secure standard streaming scheme before Electron becomes ready', () => {
    FileViewerProtocol.registerScheme()
    expect(protocolMock.registrations).toEqual([[
      {
        scheme: 'jamat-v3-file',
        privileges: {
          standard: true,
          secure: true,
          supportFetchAPI: true,
          stream: true,
        },
      },
    ]])
  })

  it('streams only granted resources and supports a single byte range', async () => {
    const handle = initialize()
    const full = await handle(new Request('jamat-v3-file://resource/token'))
    expect(full.status).toBe(200)
    expect(full.headers.get('content-type')).toBe('application/octet-stream')
    expect(full.headers.get('content-length')).toBe('10')
    expect(full.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await full.text()).toBe('abcdefghij')
    const head = await handle(new Request('jamat-v3-file://resource/token', { method: 'HEAD' }))
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe('10')
    expect(await head.text()).toBe('')
    const response = await handle(new Request('jamat-v3-file://resource/token', {
      headers: { Range: 'bytes=2-5' },
    }))
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(await response.text()).toBe('cdef')
    expect((await handle(new Request('jamat-v3-file://resource/unknown'))).status).toBe(404)
  })

  it('refuses invalid ranges and resources changed after the token was issued', async () => {
    const handle = initialize()
    expect((await handle(new Request('jamat-v3-file://resource/token', {
      headers: { Range: 'bytes=30-40' },
    }))).status).toBe(416)
    expect((await handle(new Request('jamat-v3-file://resource/token', {
      headers: { Range: 'bytes=0-1,4-5' },
    }))).status).toBe(416)
    await writeFile(resource.path, 'changed')
    expect((await handle(new Request('jamat-v3-file://resource/token'))).status).toBe(409)
  })
})
