import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs'
import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { dirname } from 'node:path'

import type {
  RemoteControlLocalResponse,
  RemoteControlResponse,
  RemoteControlSocketRequest,
  RemoteControlSocketResponse,
} from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import { AtomicJsonFile } from '../../../lib-orchestrator/shared/atomicJsonFile'
import { ErrorText } from '../../../lib-orchestrator/shared/errorText'
import { RemoteControlAuditRows, type RemoteControlAuditCaller, type RemoteControlAuditEntry } from '../../../lib-orchestrator/remoteControl/remoteControlAuditRows'

export class RemoteControlAudit {
  /** One generation kept beside the live file. Two files, bounded, is what a log like this needs. */
  private static readonly rotateBytesConst = 8_388_608
  private static readonly flushDelayMillisecondsConst = 50
  /** High-frequency local read-only polling ops excluded from routine audit writes. */
  private static readonly skippedLocalOpsConst = new Set([
    'tabs.commitStatus',
    'tabs.list',
    'system.hello',
    'sessions.list',
  ])
  private readonly pending: string[] = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private inflight: Promise<void> | null = null
  private bytes: number | null = null

  private readonly file: string
  private readonly onError: (message: string) => void
  private readonly now: () => number

  constructor(file: string, onError: (message: string) => void, now: () => number = Date.now) {
    this.file = file
    this.onError = onError
    this.now = now
  }

  http(
    request: unknown,
    response: RemoteControlResponse,
    caller: RemoteControlAuditCaller,
  ): void {
    this.control('http', request, response, caller)
  }

  localHttp(
    request: unknown,
    response: RemoteControlLocalResponse,
    caller: RemoteControlAuditCaller,
  ): void {
    this.control('http-local', request, response, caller)
  }

  remoteHttp(
    request: unknown,
    response: RemoteControlResponse,
    caller: RemoteControlAuditCaller,
    remoteEndpointId: string,
  ): void {
    this.control('http-remote', request, response, caller, { remoteEndpointId })
  }

  /**
   * One row builder for both socket transports, and `request: null` for a request that never parsed
   * - which still happened, and used to leave no trace at all, so the way to stay out of this file
   * was to send something malformed.
   */
  socket(
    transport: 'websocket' | 'peer-socket',
    request: RemoteControlSocketRequest | null,
    response: Extract<RemoteControlSocketResponse, { type: 'response' }>,
    caller: RemoteControlAuditCaller,
  ): void {
    this.append(RemoteControlAuditRows.socket(this.now(), transport, request, response, caller))
  }

  peerControl(
    request: unknown,
    response: RemoteControlResponse,
    caller: RemoteControlAuditCaller,
  ): void {
    this.control('peer-control', request, response, caller)
  }

  private control(
    transport: 'http' | 'http-local' | 'http-remote' | 'peer-control',
    request: unknown,
    response: RemoteControlResponse | RemoteControlLocalResponse,
    caller: RemoteControlAuditCaller,
    targetPrefix?: Record<string, unknown>,
  ): void {
    if ((transport === 'http' || transport === 'http-local')
      && caller.callerKind === 'local-cli'
      && response.ok
      && response.operation !== null
      && RemoteControlAudit.skippedLocalOpsConst.has(response.operation))
      return
    this.append(RemoteControlAuditRows.control(this.now(), transport, request, response, caller, targetPrefix))
  }

  /**
   * Everything queued, on disk before this returns. For a stop, where there is no next tick left to
   * carry the batch.
   */
  flush(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.appendPendingSync()
  }

  /**
   * Queued, not written. `terminal.input` audits one row per KEYSTROKE, and routine batches flush
   * asynchronously off the event loop; `flush()` remains synchronous for shutdown.
   */
  append(record: RemoteControlAuditEntry): void {
    this.pending.push(JSON.stringify(record) + '\n')
    if (this.flushTimer !== null) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.startAsyncFlush()
    }, RemoteControlAudit.flushDelayMillisecondsConst)
    this.flushTimer.unref?.()
  }

  private startAsyncFlush(): void {
    if (this.inflight !== null || this.pending.length === 0) return
    const run = this.drainAsync().finally(() => {
      if (this.inflight === run) this.inflight = null
      if (this.pending.length > 0 && this.flushTimer === null) this.startAsyncFlush()
    })
    this.inflight = run
  }

  private async drainAsync(): Promise<void> {
    while (this.pending.length > 0) {
      const batch = this.pending.splice(0).join('')
      const size = Buffer.byteLength(batch)
      try {
        await mkdir(dirname(this.file), { recursive: true })
        await this.rotateAsync(size)
        await appendFile(this.file, batch, { encoding: 'utf8', mode: 0o600 })
        this.bytes = (this.bytes ?? 0) + size
      } catch (error) {
        try {
          this.onError(`Remote control audit write failed: ${ErrorText.of(error)}`)
        } catch {}
      }
    }
  }

  private appendPendingSync(): void {
    if (this.pending.length === 0) return
    const batch = this.pending.splice(0).join('')
    const size = Buffer.byteLength(batch)
    try {
      AtomicJsonFile.ensureDirectory(dirname(this.file))
      this.rotateSync(size)
      appendFileSync(this.file, batch, { encoding: 'utf8', mode: 0o600 })
      this.bytes = (this.bytes ?? 0) + size
    } catch (error) {
      try {
        this.onError(`Remote control audit write failed: ${ErrorText.of(error)}`)
      } catch {}
    }
  }

  private rotateSync(incoming: number): void {
    if (this.bytes === null) this.bytes = RemoteControlAudit.sizeOfSync(this.file)
    if (this.bytes + incoming <= RemoteControlAudit.rotateBytesConst) return
    this.bytes = RemoteControlAudit.sizeOfSync(this.file)
    if (this.bytes + incoming <= RemoteControlAudit.rotateBytesConst) return
    renameSync(this.file, `${this.file}.1`)
    this.bytes = 0
  }

  private async rotateAsync(incoming: number): Promise<void> {
    if (this.bytes === null) this.bytes = await RemoteControlAudit.sizeOfAsync(this.file)
    if (this.bytes + incoming <= RemoteControlAudit.rotateBytesConst) return
    this.bytes = await RemoteControlAudit.sizeOfAsync(this.file)
    if (this.bytes + incoming <= RemoteControlAudit.rotateBytesConst) return
    await rename(this.file, `${this.file}.1`)
    this.bytes = 0
  }

  private static sizeOfSync(file: string): number {
    return existsSync(file) ? statSync(file).size : 0
  }

  private static async sizeOfAsync(file: string): Promise<number> {
    try { return (await stat(file)).size }
    catch { return 0 }
  }
}
