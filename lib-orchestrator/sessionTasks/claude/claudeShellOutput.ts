import { TranscriptTailReader } from '../../shared/transcriptTailReader'
import type { SessionShellOutput, SessionShellRow } from '../sessionTasksApi.types'

/**
 * The end of one Claude background shell's `b<id>.output` file, as plain text.
 *
 * The shell's state joins the revision: a shell that ends without printing again leaves its file as
 * it was, and a view holding the old revision would otherwise keep saying it runs.
 */
export class ClaudeShellOutput {
  static readonly tailBytesConst = 64 * 1024
  // CSI (7-bit and 8-bit) and OSC, terminated by BEL or ST; an OSC cut by the end of the read goes too.
  private static readonly controlPatternConst = /\u001b\[[0-?]*[ -/]*[@-~]|\u009b[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\|$)/g

  static revisionOf(file: { mtimeMs: number; size: number }, row: SessionShellRow): string {
    return `${file.mtimeMs}:${file.size}:${row.state}`
  }

  /** `known` equal to the revision answers `unchanged` without opening the file. */
  static async read(
    file: { file: string; mtimeMs: number; size: number },
    row: SessionShellRow,
    known: string | null,
  ): Promise<SessionShellOutput> {
    const revision = ClaudeShellOutput.revisionOf(file, row)
    if (known === revision) return { kind: 'unchanged', revision }
    const tail = await TranscriptTailReader.file(file, ClaudeShellOutput.tailBytesConst)
    return {
      kind: 'output',
      revision,
      command: row.command,
      state: row.state,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      text: ClaudeShellOutput.plainOf(tail.content),
      earlierOutputOmitted: !tail.startedAtFileBeginning,
    }
  }

  static plainOf(text: string): string {
    return text.replace(ClaudeShellOutput.controlPatternConst, '')
  }
}
