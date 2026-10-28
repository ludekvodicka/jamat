import { createHash } from 'node:crypto'

import type {
  FileChangeStatus,
  FileDiffData,
  FileDiffHunk,
  FileDiffLine,
  FileDiffResult,
  FileDiffVersion,
  FileHistoryCompleteness,
  FileTextEol,
} from '../fileChangesManagerApi.types'
import type {
  FileDiffExecutionContext,
  FileDiffExecutionResult,
  FileDiffExecutor,
} from './fileDiffExecutor'

export interface FileDiffBuilderInput {
  status: FileChangeStatus
  completeness: Exclude<FileHistoryCompleteness, 'unavailable'>
  detail: string | null
  current: { label: string; path: string; content: Buffer | string | null }
  baseline: { label: string; path: string; content: Buffer | string | null }
}

interface TextValue {
  text: string
  version: FileDiffVersion
}

export class FileDiffBuilder {
  /** Public, because the reader upstream has to refuse a file before it allocates it. */
  static readonly maxContentBytesConst = 2 * 1_048_576
  static readonly maxContentLabelConst = '2 MiB'

  constructor(private readonly executor: FileDiffExecutor) {}

  async build(
    input: FileDiffBuilderInput,
    context?: FileDiffExecutionContext,
  ): Promise<FileDiffResult> {
    const current = FileDiffBuilder.textOf(input.current)
    if (current.kind === 'too-large') return current.result
    const baseline = FileDiffBuilder.textOf(input.baseline)
    if (baseline.kind === 'too-large') return baseline.result
    if (current.kind === 'binary' || baseline.kind === 'binary')
      return { ok: true, kind: 'binary', detail: FileDiffBuilder.binaryDetailOf(input) }
    if (!current.value.version.exists && !baseline.value.version.exists)
      return { ok: true, kind: 'missing', detail: 'Both file versions are missing' }
    const execution = await this.execute(baseline.value, current.value, context)
    if (execution.kind === 'work-limit')
      return { ok: true, kind: 'too-complex', detail: 'The text diff exceeded its work limit' }
    else if (execution.kind === 'refused')
      return { ok: true, kind: 'busy', detail: execution.detail }
    else if (execution.kind !== 'computed')
      throw new Error(`Unknown diff execution result: ${JSON.stringify(execution)}`)
    const data: FileDiffData = {
      status: input.status,
      completeness: input.completeness,
      current: current.value.version,
      baseline: baseline.value.version,
      hunks: execution.hunks,
      detail: input.detail,
    }
    return { ok: true, kind: 'text', data }
  }

  private execute(
    baseline: TextValue,
    current: TextValue,
    context?: FileDiffExecutionContext,
  ): Promise<FileDiffExecutionResult> {
    if (!baseline.version.exists || !current.version.exists)
      return Promise.resolve({
        kind: 'computed',
        hunks: FileDiffBuilder.oneSidedHunks(baseline, current),
      })
    if (baseline.text === current.text)
      return Promise.resolve({ kind: 'computed', hunks: [] })
    return this.executor.execute({ before: baseline.text, after: current.text }, context)
  }

  private static oneSidedHunks(baseline: TextValue, current: TextValue): readonly FileDiffHunk[] {
    const removes = baseline.version.exists
    const values = FileDiffBuilder.linesOf(removes ? baseline.text : current.text)
    if (values.length === 0) return []
    const lines: FileDiffLine[] = values.map((text, index) => removes
      ? { kind: 'remove', text, beforeLine: index + 1, afterLine: null }
      : { kind: 'add', text, beforeLine: null, afterLine: index + 1 })
    return [{
      beforeStart: 1,
      beforeLines: removes ? lines.length : 0,
      afterStart: 1,
      afterLines: removes ? 0 : lines.length,
      lines,
    }]
  }

  private static linesOf(text: string): string[] {
    if (text.length === 0) return []
    const lines = text.split('\n')
    if (text.endsWith('\n')) lines.pop()
    return lines
  }

  private static textOf(input: {
    label: string
    path: string
    content: Buffer | string | null
  }): { kind: 'text'; value: TextValue } | { kind: 'too-large'; result: FileDiffResult } | { kind: 'binary' } {
    if (input.content === null)
      return {
        kind: 'text',
        value: {
          text: '',
          version: {
            label: input.label,
            path: input.path,
            exists: false,
            eol: 'none',
            finalNewline: null,
          },
        },
      }
    const bytes = typeof input.content === 'string'
      ? Buffer.byteLength(input.content)
      : input.content.length
    if (bytes > FileDiffBuilder.maxContentBytesConst)
      return {
        kind: 'too-large',
        result: {
          ok: true,
          kind: 'too-large',
          detail: `${input.label} exceeds ${FileDiffBuilder.maxContentLabelConst}`,
        },
      }
    if (Buffer.isBuffer(input.content)) {
      if (input.content.includes(0)) return { kind: 'binary' }
      const decoded = input.content.toString('utf8')
      if (!Buffer.from(decoded, 'utf8').equals(input.content)) return { kind: 'binary' }
      return { kind: 'text', value: FileDiffBuilder.textValue(input.label, input.path, decoded) }
    }
    if (input.content.includes('\0')) return { kind: 'binary' }
    return { kind: 'text', value: FileDiffBuilder.textValue(input.label, input.path, input.content) }
  }

  /**
   * Both sides of a binary file by size and SHA-256, and whether the working file equals the baseline,
   * so a person can tell which side a settled conflict kept without a text diff.
   */
  private static binaryDetailOf(input: FileDiffBuilderInput): string {
    const current = FileDiffBuilder.bytesOf(input.current.content)
    const baseline = FileDiffBuilder.bytesOf(input.baseline.content)
    const sideOf = (label: string, side: Buffer | 'absent' | 'unknown'): string => side === 'absent' ? `${label}: absent.`
      : side === 'unknown' ? `${label}: size and SHA-256 not known, it was read as text.`
      : `${label}: ${side.length} bytes, SHA-256 ${createHash('sha256').update(side).digest('hex')}.`
    const words = ['Binary file, no text diff.', sideOf(input.current.label, current), sideOf(input.baseline.label, baseline)]
    if (Buffer.isBuffer(current) && Buffer.isBuffer(baseline))
      words.push(`The ${input.current.label.toLowerCase()} file ${current.equals(baseline) ? 'equals' : 'differs from'} ${input.baseline.label}.`)
    return words.join(' ')
  }

  /** A string side holds its bytes only if decoding replaced none of them. */
  private static bytesOf(content: Buffer | string | null): Buffer | 'absent' | 'unknown' {
    if (content === null) return 'absent'
    if (Buffer.isBuffer(content)) return content
    return content.includes('�') ? 'unknown' : Buffer.from(content, 'utf8')
  }

  private static textValue(label: string, path: string, original: string): TextValue {
    return {
      text: original.replace(/\r\n/g, '\n').replace(/\r/g, '\n'),
      version: {
        label,
        path,
        exists: true,
        eol: FileDiffBuilder.eolOf(original),
        finalNewline: /(?:\r\n|\r|\n)$/.test(original),
      },
    }
  }

  private static eolOf(content: string): FileTextEol {
    const crlf = (content.match(/\r\n/g) ?? []).length
    const withoutCrlf = content.replace(/\r\n/g, '')
    const lf = (withoutCrlf.match(/\n/g) ?? []).length
    const cr = (withoutCrlf.match(/\r/g) ?? []).length
    if (crlf === 0 && lf === 0 && cr === 0) return 'none'
    else if (crlf > 0 && lf === 0 && cr === 0) return 'crlf'
    else if (crlf === 0 && lf > 0 && cr === 0) return 'lf'
    else return 'mixed'
  }
}
