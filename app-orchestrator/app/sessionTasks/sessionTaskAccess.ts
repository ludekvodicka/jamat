import type { RemoteContentCursor, RemoteContentPage } from '../../../lib-orchestrator/remoteControl/remoteContentApi.types'
import type { RemoteControlStepResult } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type { RemoteTaskRequest, RemoteTaskValue } from '../../../lib-orchestrator/remoteControl/remoteTaskApi.types'
import { RemoteContentPages } from '../remoteControl/remoteContentPages'
import { RemoteContentAccess } from '../remoteControl/remoteContentAccess'
import type { RemoteSessionInteraction } from '../remoteControl/remoteSessionViews'
import type { SessionTasksOperations } from './sessionTasksOperations'

export class SessionTaskAccess {
  private readonly tasks: Pick<SessionTasksOperations, 'listingOf' | 'scriptsOf' | 'transcriptOf' | 'shellOutputOf' | 'scriptOutputOf'>
  private readonly pages = new RemoteContentPages()
  private readonly active = new Map<string, { closed: boolean; reads: number; owners: Set<string> }>()

  constructor(tasks: SessionTaskAccess['tasks']) { this.tasks = tasks }

  async request(view: RemoteSessionInteraction, request: RemoteTaskRequest): Promise<RemoteControlStepResult<RemoteContentPage>> {
    const key = RemoteContentAccess.owner(view)
    let active = this.active.get(key)
    if (!active) { active = { closed: false, reads: 0, owners: new Set() }; this.active.set(key, active) }
    if (active.reads >= 4) return { ok: false, error: { code: 'unavailable', detail: 'Too many source task reads' } }
    active.reads++
    try {
      const result = await this.read(view.sessionId, request)
      if (active.closed) return { ok: false, error: { code: 'unavailable', detail: 'Source task view was released' } }
      const owner = SessionTaskAccess.owner(view, request)
      active.owners.add(owner)
      return this.pages.put(owner, { sessionId: view.sessionId, request, result: result.ok ? { ok: true, value: SessionTaskAccess.bounded(result.value) } : result })
    } finally { active.reads-- }
  }

  page(view: RemoteSessionInteraction, request: RemoteTaskRequest, cursor: RemoteContentCursor): RemoteControlStepResult<RemoteContentPage> {
    return this.pages.read(SessionTaskAccess.owner(view, request), cursor)
  }

  release(view: RemoteSessionInteraction): void {
    const key = RemoteContentAccess.owner(view), active = this.active.get(key)
    if (!active) return
    active.closed = true
    for (const owner of active.owners) this.pages.release(owner)
    this.active.delete(key)
  }

  private async read(sessionId: string, request: RemoteTaskRequest): Promise<RemoteControlStepResult<RemoteTaskValue>> {
    switch (request.kind) {
      case 'list': return { ok: true, value: { listing: await this.tasks.listingOf(sessionId), scripts: this.tasks.scriptsOf(sessionId) } }
      case 'transcript': return { ok: true, value: await this.tasks.transcriptOf(sessionId, request.subagentId, request.known ?? null) }
      case 'shell': return { ok: true, value: await this.tasks.shellOutputOf(sessionId, request.shellId, request.known ?? null) }
      case 'script': return this.tasks.scriptOutputOf(sessionId, request.runId)
      default: throw new Error(`Unknown source task request: ${JSON.stringify(request satisfies never)}`)
    }
  }

  private static owner(view: RemoteSessionInteraction, request: RemoteTaskRequest): string {
    const identity = 'known' in request ? { ...request, known: undefined } : request
    return JSON.stringify([RemoteContentAccess.owner(view), identity])
  }

  private static bounded(value: RemoteTaskValue): RemoteTaskValue {
    if ('lines' in value) {
      const text = value.lines.join('\n')
      if (text.length <= 64 * 1024) return value
      return { ...value, lines: text.slice(-64 * 1024).split('\n'), logReason: 'Earlier output omitted from this source snapshot.' }
    }
    if (!('kind' in value)) return value
    switch (value.kind) {
      case 'transcript': {
        let entries = [...value.entries]
        while (entries.length && Buffer.byteLength(JSON.stringify(entries), 'utf8') > 512 * 1024) entries = entries.slice(Math.max(1, Math.floor(entries.length / 4)))
        return { ...value, entries, earlierStepsOmitted: value.earlierStepsOmitted || entries.length !== value.entries.length }
      }
      case 'output': return value.text.length <= 64 * 1024 ? value : { ...value, text: value.text.slice(-64 * 1024), earlierOutputOmitted: true }
      case 'unchanged':
      case 'none': return value
      default: throw new Error(`Unknown source task output: ${JSON.stringify(value satisfies never)}`)
    }
  }
}
