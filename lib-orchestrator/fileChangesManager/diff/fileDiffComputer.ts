import { structuredPatch, type StructuredPatch } from 'diff'

import type { FileDiffHunk, FileDiffLine } from '../fileChangesManagerApi.types'
import type {
  FileDiffComputeInput,
  FileDiffExecutionResult,
  FileDiffExecutor,
} from './fileDiffExecutor'
import { FileDiffLimitsConst } from './fileDiffLimits'

export class FileDiffComputer implements FileDiffExecutor {
  async execute(input: FileDiffComputeInput): Promise<FileDiffExecutionResult> {
    return FileDiffComputer.compute(input)
  }

  static compute(input: FileDiffComputeInput): FileDiffExecutionResult {
    const patch = structuredPatch(
      'baseline',
      'current',
      input.before,
      input.after,
      undefined,
      undefined,
      {
        context: FileDiffLimitsConst.contextLines,
        timeout: FileDiffLimitsConst.timeoutMilliseconds,
        maxEditLength: FileDiffLimitsConst.maxEditLength,
      },
    )
    return patch === undefined
      ? { kind: 'work-limit' }
      : { kind: 'computed', hunks: patch.hunks.map(FileDiffComputer.hunkOf) }
  }

  private static hunkOf(hunk: StructuredPatch['hunks'][number]): FileDiffHunk {
    let beforeLine = hunk.oldStart
    let afterLine = hunk.newStart
    const lines: FileDiffLine[] = []
    for (const value of hunk.lines) {
      const prefix = value[0]
      if (prefix === '\\') continue
      if (prefix === ' ') {
        lines.push({ kind: 'context', text: value.slice(1), beforeLine, afterLine })
        beforeLine += 1
        afterLine += 1
      }
      else if (prefix === '-') {
        lines.push({ kind: 'remove', text: value.slice(1), beforeLine, afterLine: null })
        beforeLine += 1
      }
      else if (prefix === '+') {
        lines.push({ kind: 'add', text: value.slice(1), beforeLine: null, afterLine })
        afterLine += 1
      }
      else
        throw new Error(`Unknown diff line: ${JSON.stringify(value)}`)
    }
    return {
      beforeStart: hunk.oldStart,
      beforeLines: hunk.oldLines,
      afterStart: hunk.newStart,
      afterLines: hunk.newLines,
      lines,
    }
  }
}
