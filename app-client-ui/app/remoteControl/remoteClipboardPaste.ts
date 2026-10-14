import { randomUUID } from 'node:crypto'
import { open, stat } from 'node:fs/promises'
import { basename } from 'node:path'

import type { RemoteControlStepResult } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import {
  RemoteControlPasteFileConst,
  RemoteControlPasteImageConst,
} from '../../../lib-orchestrator/remoteControl/remoteControlProtocol'
import type { TerminalClipboardPaste } from '../../shared/terminalClipboardPaste'
import { ClipboardAccess } from '../shared/clipboardAccess'
import { ClipboardPastePaths } from '../shared/clipboardPastePaths'
import type { RemoteConnectionsManager } from './remoteConnectionsManager'

/**
 * This computer's clipboard, pasted into a terminal on another one.
 *
 * The agent there reads that computer's clipboard and disk, so nothing here is pasted as it stands
 * when it names something only this computer has. A file the clipboard names, as a path in the text
 * or as Explorer's copied file, is sent and its path there is pasted; past the size limit the local
 * path is pasted with the reason, so a person reading the prompt knows why the agent cannot open it.
 * An image is sent the same way. Any other text is pasted as it is.
 */
export class RemoteClipboardPaste {
  private readonly outbound: Pick<RemoteConnectionsManager, 'terminalPasteImage' | 'terminalPasteFile'>

  constructor(outbound: Pick<RemoteConnectionsManager, 'terminalPasteImage' | 'terminalPasteFile'>) {
    this.outbound = outbound
  }

  async paste(endpointId: string, attachId: string): Promise<RemoteControlStepResult<TerminalClipboardPaste>> {
    const text = ClipboardAccess.readText()
    if (text.length > 0) {
      const files = ClipboardPastePaths.filesOf(text)
      return files === null ? { ok: true, value: { kind: 'text', text } } : this.sendFiles(endpointId, attachId, files)
    }
    const dropped = ClipboardAccess.readFileDrop()
    if (dropped !== null) return this.sendFiles(endpointId, attachId, [dropped])
    const read = ClipboardAccess.readImage(RemoteControlPasteImageConst.bytesMaxConst)
    if (read.kind === 'none') return { ok: true, value: { kind: 'empty' } }
    else if (read.kind === 'too-large')
      return { ok: false, error: { code: 'invalid-request', detail: 'The clipboard image is too large to send' } }
    else if (read.kind === 'image') {
      const saved = await this.outbound.terminalPasteImage(endpointId, attachId, Buffer.from(read.bytes).toString('base64'))
      if (!saved.ok) return RemoteClipboardPaste.refusal(saved)
      return { ok: true, value: { kind: 'text', text: ClipboardPastePaths.textOf(saved.value.path) } }
    } else
      throw new Error(`Unknown clipboard read: ${JSON.stringify(read)}`)
  }

  private async sendFiles(
    endpointId: string,
    attachId: string,
    paths: readonly string[],
  ): Promise<RemoteControlStepResult<TerminalClipboardPaste>> {
    const pieces: string[] = []
    for (const path of paths) {
      const size = (await stat(path)).size
      if (size > RemoteControlPasteFileConst.bytesMaxConst) {
        pieces.push(`${ClipboardPastePaths.textOf(path)} (not transferred: ${RemoteClipboardPaste.megabytesOf(size)}, the limit is ${RemoteClipboardPaste.megabytesOf(RemoteControlPasteFileConst.bytesMaxConst)})`)
        continue
      }
      const sent = await this.sendFile(endpointId, attachId, path, size)
      if (!sent.ok) return RemoteClipboardPaste.refusal(sent)
      pieces.push(ClipboardPastePaths.textOf(sent.value))
    }
    return { ok: true, value: { kind: 'text', text: pieces.join(' ') } }
  }

  /** In order, one chunk at a time: the far side appends and refuses anything out of order. */
  private async sendFile(
    endpointId: string,
    attachId: string,
    path: string,
    size: number,
  ): Promise<RemoteControlStepResult<string>> {
    const uploadId = randomUUID()
    const fileName = basename(path)
    const handle = await open(path, 'r')
    try {
      let offset = 0
      do {
        const buffer = Buffer.alloc(Math.min(RemoteControlPasteFileConst.chunkBytesConst, size - offset))
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
        if (bytesRead !== buffer.length)
          return { ok: false, error: { code: 'operation-failed', detail: `${fileName} changed while it was being sent` } }
        const answer = await this.outbound.terminalPasteFile(endpointId, attachId, {
          uploadId,
          fileName,
          size,
          offset,
          data: buffer.toString('base64'),
        })
        if (!answer.ok) return answer
        offset += bytesRead
        if (answer.value.path !== null) return { ok: true, value: answer.value.path }
      } while (offset < size)
      return { ok: false, error: { code: 'operation-failed', detail: `The remote computer did not confirm ${fileName}` } }
    } finally {
      await handle.close()
    }
  }

  /**
   * An older Jamat on the other computer never offered the operation, and the channel says so in
   * protocol words; the person needs to know which computer to update.
   */
  private static refusal(answer: Extract<RemoteControlStepResult<unknown>, { ok: false }>): RemoteControlStepResult<never> {
    if (answer.error.code === 'forbidden')
      return {
        ok: false,
        error: { code: 'forbidden', detail: 'The remote computer runs a Jamat without image and file paste; update it' },
      }
    return answer
  }

  private static megabytesOf(bytes: number): string {
    return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`
  }
}
