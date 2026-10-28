import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FileViewer } from '../../lib-orchestrator/fileViewer/fileViewer.js'
import type { FileViewerOpenResult, FileViewerResourceResult } from '../../lib-orchestrator/fileViewer/fileViewerApi.types.js'
import type { SessionManager } from '../../lib-orchestrator/sessionManager/sessionManager.js'
import type { RemoteSessionView } from '../../lib-orchestrator/remoteControl/remoteSessionApi.types.js'
import type { RemoteFileBytes } from '../../lib-orchestrator/remoteControl/remoteContentApi.types.js'
import { RemoteControlConst } from '../../lib-orchestrator/remoteControl/remoteControlProtocol.js'
import { FileViewerAccess } from '../../app-client-ui/app/fileViewer/fileViewerAccess.js'
import { RemoteFileMediaSource } from '../../app-client-ui/app/fileViewer/remoteFileMediaSource.js'
import { RemoteContentAccess } from '../../app-client-ui/app/remoteControl/remoteContentAccess.js'
import { RemoteContentClient } from '../../app-client-ui/app/remoteControl/remoteContentClient.js'
import { RemoteSessionViews } from '../../app-client-ui/app/remoteControl/remoteSessionViews.js'
import type { RemoteConnectionsManager } from '../../app-client-ui/app/remoteControl/remoteConnectionsManager.js'
import type { RemoteReviewAccess } from '../../app-client-ui/app/remoteControl/remoteReviewAccess.js'

export class RemoteContentScenarios {
  readonly views: RemoteSessionViews
  readonly viewer = new FileViewer()
  readonly content: RemoteContentAccess
  reviews?: RemoteReviewAccess

  constructor(sessions: SessionManager) {
    const refused = async (): Promise<FileViewerOpenResult> => ({ ok: false, code: 'invalid-source', detail: 'No fixture proof' })
    const access = new FileViewerAccess({ viewer: this.viewer, sessions, restoreDetected: refused,
      allowsDetected: () => false, restoreExternal: refused, restoreWorkingTree: refused })
    this.content = new RemoteContentAccess(access, this.viewer)
    this.views = new RemoteSessionViews({
      exists: (id) => sessions.snapshot().sessions.some((session) => session.sessionId === id),
      press: async () => ({ ok: false, error: { code: 'forbidden', detail: 'No fixture action' } }),
      read: async (view, request) => {
        if (request.operation === 'files.request') return this.content.request(view, request.body)
        else if (request.operation === 'files.page') return this.content.page(view, request.body)
        else if (request.operation === 'reviews.request' && this.reviews) return this.reviews.request(view, request.body)
        else if (request.operation === 'reviews.page' && this.reviews) return this.reviews.page(view, request.body)
        else throw new Error(`Unsupported fixture request ${request.operation}`)
      },
      release: (view) => { this.content.release(view); this.reviews?.release(view) },
    })
  }

  static async open(connections: RemoteConnectionsManager, endpointId: string, sessionId: string, viewerId: string): Promise<RemoteSessionView> {
    const selected = await connections.selectSession(endpointId, sessionId)
    assert(selected.ok, JSON.stringify(selected))
    const epoch = connections.viewEpoch(endpointId)
    assert(epoch)
    const answer = await connections.sessionView(endpointId, { operation: 'views.open', epoch, requestId: randomUUID(), body: { sessionId, viewerId } })
    assert(answer.ok && answer.value && 'viewId' in answer.value, JSON.stringify(answer))
    return answer.value
  }

  static async prove(connections: RemoteConnectionsManager, endpointId: string, sessionId: string, root: string): Promise<void> {
    const directory = join(root, 'source-only-preview')
    await mkdir(directory, { recursive: true })
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=', 'base64')
    const files = new Map([
      ['report.md', Buffer.from('# Source only\n![Source asset](image.png)\n' + 'Unicode \u017dlu\u0165ou\u010dk\u00fd \ud83d\ude00 '.repeat(18000))],
      ['page.html', Buffer.from('<h1>Source only</h1><img src="image.png">')],
      ['image.png', image], ['animated.gif', Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')],
      ['drawing.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>')],
      ['clip.mp4', Buffer.from('source-video-range')], ['binary.bin', Buffer.alloc(300_123, 173)],
    ])
    for (const [name, bytes] of files) await writeFile(join(directory, name), bytes)
    const view = await this.open(connections, endpointId, sessionId, 'content-window')
    let pages = 0
    const client = new RemoteContentClient(async (endpoint, request) => {
      const result = await connections.sessionView(endpoint, request)
      assert(Buffer.byteLength(JSON.stringify(result)) < 256 * 1024, 'Encoded page exceeds the wire budget')
      pages++
      return result
    })
    const media = new RemoteFileMediaSource(client, (endpoint, epoch) => connections.viewEpoch(endpoint) === epoch)
    let retained: { documentId: string; token: string } | undefined
    for (const [name, expected] of files) {
      const opened = await client.read<FileViewerOpenResult>(endpointId, view,
        { kind: 'restore', source: { kind: 'workspace', sessionId, path: join(directory, name) }, supportsDiff: false })
      assert(opened.ok, `${name} opens on its source`)
      const document = opened.value
      const version = document.contentVersion
      assert(version)
      const parts: Buffer[] = []
      const transfer = (async () => {
        for (let offset = 0; offset < expected.length; offset += 65536) {
          const answer = await client.read<{ ok: true; value: RemoteFileBytes } | { ok: false }>(endpointId, view, { kind: 'bytes', documentId: document.documentId,
            version, offset, length: Math.min(65536, expected.length - offset) })
          assert(answer.ok)
          parts.push(Buffer.from(answer.value.base64, 'base64'))
        }
      })()
      const progress = connections.execute(endpointId, { protocol: RemoteControlConst.protocol, requestId: randomUUID(), operation: 'terminal.peek', body: { session: { kind: 'sessionId', sessionId } } })
      await transfer
      assert((await progress).ok, 'Terminal control progresses beside content reads')
      assert.deepEqual(Buffer.concat(parts), expected, `${name} bytes match the source`)
      if (name === 'report.md' || name === 'page.html') {
        const resource = await client.read<FileViewerResourceResult>(endpointId, view, { kind: 'relative', documentId: document.documentId, reference: 'image.png' })
        assert(resource.ok)
        const token = media.issue(endpointId, view, document.documentId, resource.value).resourceId
        assert.deepEqual(Buffer.from(await media.read(token, resource.value.contentVersion, 2, 12, new AbortController().signal)), image.subarray(2, 14))
      } else if (name === 'image.png') {
        const resource = await client.read<FileViewerResourceResult>(endpointId, view, { kind: 'media', documentId: document.documentId })
        assert(resource.ok)
        retained = { documentId: document.documentId, token: media.issue(endpointId, view, document.documentId, resource.value).resourceId }
      }
    }
    assert(pages > 20, 'Large text and binary traverse multiple bounded pages')
    assert(retained)
    await writeFile(join(directory, 'image.png'), Buffer.concat([image, Buffer.from('changed')]))
    assert.equal((await media.metadata(retained.token)).kind, 'changed')
    const closed = await connections.sessionView(endpointId, { ...view, requestId: randomUUID(), operation: 'views.close', body: {} })
    assert(closed.ok)
    assert.equal((await media.metadata(retained.token)).kind, 'missing')
    const replacement = await this.open(connections, endpointId, sessionId, 'content-window')
    assert.notEqual(replacement.viewId, view.viewId)
    const fresh = await client.read<FileViewerOpenResult>(endpointId, replacement,
      { kind: 'restore', source: { kind: 'workspace', sessionId, path: join(directory, 'report.md') }, supportsDiff: false })
    assert(fresh.ok)
    await connections.sessionView(endpointId, { ...replacement, requestId: randomUUID(), operation: 'views.close', body: {} })
    console.log('remote-content: source rich/media/binary bytes, bounds, terminal progress, changed version, revoked and fresh grants passed')
  }
}
