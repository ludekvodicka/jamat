import type { CodexSessionIdentity, CodexSessionLaunch } from '../../lib-orchestrator/sessionManager/codexSessionIdentity'

type ObjectValue = Record<string, unknown>
type PendingIdentity = { method: string; params: ObjectValue; sequence: number }

export class CodexIdentity {
  private readonly launch: CodexSessionLaunch
  private readonly pending = new Map<string | number, PendingIdentity>()
  private nextSequence = 0
  private acceptedSequence = 0

  constructor(launch: CodexSessionLaunch) {
    this.launch = launch
  }

  sent(value: unknown): void {
    const message = CodexIdentity.object(value)
    if (!message || !CodexIdentity.requestId(message.id)) return
    if (message.method !== 'thread/start' && message.method !== 'thread/resume'
      && message.method !== 'thread/fork') return
    if (this.pending.has(message.id)) throw new Error('Duplicate Codex identity request ID')
    if (this.pending.size >= 1024) throw new Error('Too many pending Codex identity requests')
    this.pending.set(message.id, {
      method: message.method,
      params: CodexIdentity.object(message.params) ?? {},
      sequence: ++this.nextSequence,
    })
  }

  received(value: unknown): CodexSessionIdentity | null {
    const message = CodexIdentity.object(value)
    if (!message || !CodexIdentity.requestId(message.id) || message.method !== undefined) return null
    const request = this.pending.get(message.id)
    if (!request) return null
    this.pending.delete(message.id)
    if (message.error !== undefined) return null
    const result = CodexIdentity.object(message.result)
    const thread = CodexIdentity.object(result?.thread)
    if (!thread || !CodexIdentity.uuid(thread.id))
      throw new Error('Codex did not return a valid thread.id for its identity request')
    // Reading a child in the native agents view must not replace the tab's conversation.
    if (typeof thread.source === 'object' || thread.parentThreadId != null
      || (thread.threadSource != null && thread.threadSource !== 'user')) return null
    if (thread.source !== 'cli' && thread.source !== 'vscode' && thread.source !== 'exec')
      throw new Error('Codex returned an unsupported thread source')
    if (request.method === 'thread/resume' && request.params.threadId !== thread.id)
      throw new Error('Codex resumed a different thread than the one requested')
    if (request.method === 'thread/fork'
      && (request.params.threadId === thread.id || request.params.threadId !== thread.forkedFromId))
      throw new Error('Codex returned a fork without the requested parent')
    if (this.acceptedSequence === 0) this.checkInitial(request, thread.id)
    if (request.sequence <= this.acceptedSequence) return null
    this.acceptedSequence = request.sequence
    return {
      schemaVersion: 1,
      jamatSessionId: this.launch.jamatSessionId,
      launchId: this.launch.launchId,
      nativeSessionId: thread.id,
      sequence: request.sequence,
    }
  }

  private checkInitial(request: PendingIdentity, nativeId: string): void {
    const mode = this.launch.mode
    if (mode === 'new') {
      if (request.method !== 'thread/start') throw new Error('Codex did not start the requested new thread')
    } else if (mode === 'resume') {
      if (request.method !== 'thread/resume' || nativeId !== this.launch.nativeSessionId)
        throw new Error('Codex did not confirm the requested resume identity')
    } else if (mode === 'fork') {
      if (request.method !== 'thread/fork' || request.params.threadId !== this.launch.forkParentId)
        throw new Error('Codex did not confirm the requested fork identity')
    } else if (mode === 'continue') {
      if (request.method !== 'thread/resume') throw new Error('Codex did not confirm the selected thread')
    } else throw new Error(`Unknown Codex launch mode: ${JSON.stringify(mode)}`)
  }

  private static object(value: unknown): ObjectValue | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as ObjectValue : null
  }

  private static requestId(value: unknown): value is string | number {
    return typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value))
  }

  private static uuid(value: unknown): value is string {
    return typeof value === 'string'
      && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value)
  }
}
