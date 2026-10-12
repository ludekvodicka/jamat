import type { SessionRecordSetupCommand } from '../records/sessionRecord.types'
import type { SessionScriptId, SessionScriptPhase } from '../sessionManagerApi.types'
import { ScriptDuration } from './scriptDuration'

export interface ScriptLogHeader {
  phase: SessionScriptPhase
  scriptId: SessionScriptId
  name: string
  parentId: string
  parentTitle: string
  runId: string
  startedAt: number
  endedAt: number
  exitCode?: number
  reason?: string
  /** The install runs with echo off, so only the header names what it ran. */
  commands: readonly SessionRecordSetupCommand[]
}

/** The text of one saved run log: a header that says what ran, then the rows the terminal showed. */
export class ScriptLogText {
  static readonly maxBytesConst = 262_144
  /** The install shell dims its own notices with SGR 2 and 22; in a text file they are noise. */
  private static readonly dimMarkersConst = /\u001b\[(?:2|22)m/g
  private static readonly separatorConst = '-'.repeat(60)

  /** Header, then the rows without dim markers; past the cap the earliest rows go and the header says so. */
  static of(header: ScriptLogHeader, rows: readonly string[]): { text: string; truncated: boolean } {
    const clean = rows.map((row) => row.replace(ScriptLogText.dimMarkersConst, ''))
    const rowBytes = clean.map((row) => Buffer.byteLength(row, 'utf8') + 1)
    const rowsTotal = rowBytes.reduce((sum, bytes) => sum + bytes, 0)
    const whole = ScriptLogText.headerOf(header, 0)
    if (Buffer.byteLength(whole, 'utf8') + rowsTotal <= ScriptLogText.maxBytesConst)
      return { text: whole + ScriptLogText.bodyOf(clean), truncated: false }

    // Budgeted against the longest count the truncation line can print, so the final header fits too.
    const budget = ScriptLogText.maxBytesConst
      - Buffer.byteLength(ScriptLogText.headerOf(header, clean.length), 'utf8')
    let used = 0
    let first = clean.length
    while (first > 0 && used + rowBytes[first - 1] <= budget) {
      first -= 1
      used += rowBytes[first]
    }
    return { text: ScriptLogText.headerOf(header, first) + ScriptLogText.bodyOf(clean.slice(first)), truncated: true }
  }

  private static headerOf(header: ScriptLogHeader, droppedRows: number): string {
    const lines = [
      `Script:    ${header.name} (${header.scriptId})`,
      `Phase:     ${header.phase}`,
      `Parent:    ${header.parentTitle} (${header.parentId})`,
      `Run:       ${header.runId}`,
      `Started:   ${new Date(header.startedAt).toISOString()}`,
      `Ended:     ${new Date(header.endedAt).toISOString()}`,
      `Duration:  ${ScriptDuration.text(header.endedAt - header.startedAt)}`,
      `Exit code: ${header.exitCode ?? 'none'}`,
    ]
    if (header.reason !== undefined) lines.push(`Reason:    ${header.reason}`)
    if (header.commands.length === 0) lines.push('Commands:  none')
    else {
      lines.push('Commands:')
      for (const command of header.commands) lines.push(`  ${command.command}`, `    in ${command.cwd}`)
    }
    if (droppedRows > 0)
      lines.push(`Truncated: the earliest ${droppedRows} rows were removed to keep the log under ${ScriptLogText.maxBytesConst / 1024} KiB`)
    lines.push(ScriptLogText.separatorConst)
    return `${lines.join('\n')}\n`
  }

  private static bodyOf(rows: readonly string[]): string {
    return rows.length === 0 ? '' : `${rows.join('\n')}\n`
  }
}
