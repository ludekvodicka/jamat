import { z } from 'zod'
import { SessionNumberView } from '../sessionManager/sessionNumberView'
import type { PerfName, PerfRecord } from './perfRecord.types'

export class PerfNames {
  private readonly names: Set<string>
  private readonly schema: z.ZodType

  constructor(channels: readonly string[] = [], operations: readonly string[] = []) {
    this.names = new Set([
      'other', 'unattributed', 'sessions.recompose', 'records.commit', 'finish.commit', 'finish.sync',
      'snapins.tick', 'fileChanges.poll', 'rate.pass', 'gateway.frame',
      ...channels.map(name => `ipc:${name}`), ...operations.map(name => `op:${name}`),
      ...['status', 'info', 'diff', 'log', 'update', 'add', 'delete', 'move', 'copy', 'commit', 'checkout',
        'propset', 'propget', 'proplist', 'revert', 'resolve', 'cleanup', 'list', 'cat', 'merge', 'switch']
        .map(name => `svn:${name}`),
      ...['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'add', 'commit', 'worktree', 'merge',
        'branch', 'checkout', 'config', 'init', 'reset', 'restore', 'fetch', 'push', 'cat-file']
        .map(name => `git:${name}`),
    ])
    this.schema = PerfNames.schemaFor(value => this.accepts(value))
  }

  private static schemaFor(accepts: (value: string) => boolean): z.ZodType {
    const number = z.number().finite().nonnegative()
    const process = z.enum(['main', 'gateway', 'orchestrator', 'renderer', 'host', 'machine',
      'worker:tokenUsage', 'worker:fileDiff', 'worker:svnAssembly'])
    const name = z.string().refine(accepts)
    const session = z.string().max(SessionNumberView.numberCharactersConst).refine(SessionNumberView.isSelectorNumber)
    const sessionKind = z.enum(['agent', 'script', 'shell'])
    const image = z.string().max(128).regex(/^[\p{L}\p{N}_. ()-]+$/u)
    const base = {
      v: z.literal(1), at: number.max(8.64e15), process, pid: number.int(),
      build: z.strictObject({ version: z.string().max(64).regex(/^[\w.+-]+$/),
        inputHash: z.string().regex(/^(?:[a-f0-9]{64}|dev-\d+)$/), builtAt: z.iso.datetime() }),
    }
    return z.discriminatedUnion('kind', [
      z.strictObject({ ...base, kind: z.literal('sample'), elu: number.max(1).nullable(),
        loopP50: number.nullable(), loopP99: number.nullable(), loopMax: number.nullable(), heapMb: number.nullable() }),
      z.strictObject({ ...base, kind: z.literal('stall'), ms: number, covered: z.array(name).max(256) }),
      z.strictObject({ ...base, kind: z.literal('span'), name, ms: number, selfMs: number, depth: number.int(), blocking: z.boolean() }),
      z.strictObject({ ...base, kind: z.enum(['unresponsive', 'hang']), target: process, ms: number }),
      z.strictObject({ ...base, kind: z.literal('inputToFrame'), p50: number, p99: number, count: number.int() }),
      z.strictObject({ ...base, kind: z.literal('profile'), profileId: z.string().regex(/^[a-zA-Z0-9_-]+\.cpuprofile$/), trigger: z.enum(['elu', 'stall']) }),
      z.strictObject({ ...base, kind: z.literal('machine'), cpu: number.max(1), jamatCpu: number.max(1).nullable() }),
      z.strictObject({ ...base, kind: z.literal('external'), top: z.array(z.strictObject({ image, cores: number,
        session: session.nullable(), sessionKind: sessionKind.nullable() })).max(10) }),
      z.strictObject({ ...base, kind: z.literal('runaway'), image, cores: number, minutes: number, session, sessionKind }),
      z.strictObject({ ...base, kind: z.enum(['suspend', 'resume', 'truncated']) }),
    ])
  }

  private static readonly persistedNames = new PerfNames()
  private static readonly persistedSchema = PerfNames.schemaFor(value =>
    /^(?:ipc|op):[A-Za-z0-9_.:-]{1,160}$/.test(value) || PerfNames.persistedNames.accepts(value))

  static readRecord(value: unknown): PerfRecord | null {
    return PerfNames.parse(PerfNames.persistedSchema, value)
  }

  accepts(name: string): name is PerfName { return this.names.has(name) }

  registerOperations(names: readonly string[]): void {
    for (const name of names) this.names.add(`op:${name}`)
  }

  record(value: unknown): PerfRecord | null {
    return PerfNames.parse(this.schema, value)
  }

  private static parse(schema: z.ZodType, value: unknown): PerfRecord | null {
    const parsed = schema.safeParse(value)
    if (!parsed.success) return null
    const record = parsed.data as PerfRecord
    if (record.kind === 'span' && record.selfMs > record.ms) return null
    return record
  }
}
