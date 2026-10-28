import { randomUUID } from 'node:crypto'
import type { FileViewerResource } from '../../../lib-orchestrator/fileViewer/fileViewerApi.types'
import type { RemoteFileBytes } from '../../../lib-orchestrator/remoteControl/remoteContentApi.types'
import type { RemoteSessionView } from '../../../lib-orchestrator/remoteControl/remoteSessionApi.types'
import type { RemoteContentClient } from '../remoteControl/remoteContentClient'
import type { FileMediaMetadata, FileMediaSource } from './fileMediaSource'

interface Token {
  endpointId: string
  view: RemoteSessionView
  documentId: string
  resource: FileViewerResource
  controller: AbortController
}

export class RemoteFileMediaSource implements FileMediaSource {
  private readonly client: Pick<RemoteContentClient, 'read'>
  private readonly connected: (endpointId: string, epoch: string) => boolean
  private readonly tokens = new Map<string, Token>()
  private readonly slots = new Map<string, { active: Set<Promise<void>>; waiting: number }>()

  constructor(client: Pick<RemoteContentClient, 'read'>, connected: RemoteFileMediaSource['connected']) {
    this.client = client
    this.connected = connected
  }

  issue(endpointId: string, view: RemoteSessionView, documentId: string, resource: FileViewerResource): FileViewerResource {
    while (this.tokens.size >= 512) this.revoke(this.tokens.keys().next().value!)
    const token = randomUUID()
    this.tokens.set(token, { endpointId, documentId, view: { ...view }, resource: { ...resource }, controller: new AbortController() })
    return { ...resource, resourceId: token }
  }

  releaseToken(token: string): void { this.revoke(token) }

  owns(token: string): boolean { return this.tokens.has(token) }

  releaseView(endpointId: string, viewId: string, documentId?: string): void {
    for (const [token, held] of this.tokens)
      if (held.endpointId === endpointId && held.view.viewId === viewId && (documentId === undefined || held.documentId === documentId)) this.revoke(token)
  }

  reconcile(): void { for (const token of this.tokens.keys()) this.live(token) }

  disconnected(endpointId: string): void {
    for (const [token, held] of this.tokens)
      if (held.endpointId === endpointId) this.revoke(token)
  }

  async metadata(token: string): Promise<FileMediaMetadata> {
    const held = this.live(token)
    if (!held) return { kind: 'missing' }
    try {
      const result = await this.client.read<{ kind: 'ready'; resource: FileViewerResource } | { kind: 'missing' | 'changed' }>(held.endpointId, held.view,
        { kind: 'resource-metadata', resourceId: held.resource.resourceId, version: held.resource.contentVersion }, held.controller.signal)
      if (!this.live(token)) return { kind: 'missing' }
      if (result.kind === 'changed' || result.kind === 'missing') return result
      else if (result.kind === 'ready') {
        if (result.resource.contentVersion !== held.resource.contentVersion || result.resource.size !== held.resource.size) return { kind: 'changed' }
        return { kind: 'ready', mimeType: held.resource.mimeType, size: held.resource.size, version: held.resource.contentVersion }
      } else throw new Error(`Unknown media metadata: ${JSON.stringify(result)}`)
    } catch { return { kind: 'missing' } }
  }

  async read(token: string, version: string, offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
    const held = this.live(token)
    if (!held || version !== held.resource.contentVersion) throw new Error('Media token expired or changed')
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 65536 || offset + length > held.resource.size)
      throw new Error('Invalid media range')
    const combined = AbortSignal.any([signal, held.controller.signal])
    const state = this.slots.get(held.endpointId) ?? { active: new Set<Promise<void>>(), waiting: 0 }
    this.slots.set(held.endpointId, state)
    state.waiting++
    let done!: () => void
    let slot: Promise<void>
    try {
      while (state.active.size >= 4)
        await RemoteFileMediaSource.wait(Promise.race(state.active), combined)
      combined.throwIfAborted()
      slot = new Promise<void>((resolve) => { done = resolve })
      state.active.add(slot)
    } finally {
      state.waiting--
      if (state.waiting === 0 && state.active.size === 0) this.slots.delete(held.endpointId)
    }
    try {
      const result = await this.client.read<{ ok: true; value: RemoteFileBytes } | { ok: false; detail: string }>(held.endpointId, held.view,
        { kind: 'resource-bytes', resourceId: held.resource.resourceId, version, offset, length }, combined)
      combined.throwIfAborted()
      if (!this.live(token) || !result.ok) throw new Error(result.ok ? 'Media token revoked' : result.detail)
      const value = result.value
      const bytes = Buffer.from(value.base64, 'base64')
      if (value.version !== version || value.offset !== offset || value.totalSize !== held.resource.size || value.length !== bytes.length
        || bytes.length !== length || value.eof !== (offset + length === held.resource.size) || bytes.toString('base64') !== value.base64)
        throw new Error('Invalid remote media bytes')
      return bytes
    } finally {
      state.active.delete(slot); done()
      if (state.waiting === 0 && state.active.size === 0) this.slots.delete(held.endpointId)
    }
  }

  private static wait(promise: Promise<void>, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    return new Promise((resolve, reject) => {
      const abort = (): void => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      void promise.then(() => { signal.removeEventListener('abort', abort); resolve() }, (error) => { signal.removeEventListener('abort', abort); reject(error) })
    })
  }

  private live(token: string): Token | null {
    const held = this.tokens.get(token)
    if (!held) return null
    if (!this.connected(held.endpointId, held.view.epoch)) { this.revoke(token); return null }
    return held
  }

  private revoke(token: string): void {
    this.tokens.get(token)?.controller.abort()
    this.tokens.delete(token)
  }
}
