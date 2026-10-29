import { randomUUID } from 'node:crypto'
import { link, mkdir, readdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { z } from 'zod'

import { AtomicJsonFile } from '../../shared/atomicJsonFile'
import { ErrnoCode } from '../../shared/errnoCode'
import { OrchestratorPaths } from '../../shared/orchestratorPaths'
import { PathCompare } from '../../shared/pathCompare'
import type { RuntimeChannel } from '../../shared/configIdentity.types'
import type { PassBrief } from './snapinContract'

const at = z.number().finite().nonnegative()
const text = z.string().refine((value) => Buffer.byteLength(value, 'utf8') <= 65_536)
const eventSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('started'), at, agent: z.enum(['claude', 'codex']).optional(), ppVersion: z.string().optional(), trail: z.string().optional() }),
  z.strictObject({ kind: z.literal('working'), at }),
  z.strictObject({ kind: z.literal('note'), at, note: z.string().max(4_000) }),
  z.strictObject({ kind: z.literal('done'), at, outcome: z.enum(['closed', 'published', 'analysis', 'blocked', 'ready']),
    waiting: z.enum(['user', 'blocked', 'deploy', 'foreign-deploy']).optional(), detail: text, note: text.optional(), report: text.optional() }),
])
const briefSchema = z.object({ schema: z.literal(1), attemptId: z.uuid(), kind: z.string().min(1),
  mode: z.enum(['wc', 'wt']), projectDirectory: z.string().min(1), priorAttemptId: z.uuid().nullable(),
  work: z.looseObject({ kind: z.string().min(1) }) })

export type PassEvent = z.infer<typeof eventSchema>

export class PassInbox {
  readonly directory: string
  readonly identity: string
  readonly channel: RuntimeChannel
  private readonly value: PassBrief

  private constructor(directory: string, identity: string, channel: RuntimeChannel, brief: PassBrief) {
    this.directory = directory
    this.identity = identity
    this.channel = channel
    this.value = brief
  }

  static validateEvent(value: unknown): PassEvent { return eventSchema.parse(value) }

  static async create(directory: string, brief: PassBrief): Promise<PassInbox> {
    const parsed = briefSchema.parse(brief)
    const [, , kind, attemptId] = PassInbox.parts(directory)
    if (parsed.attemptId !== attemptId || parsed.kind !== kind) throw new Error('Pass brief identity does not match its directory')
    await mkdir(directory, { recursive: true })
    await PassInbox.checkedDirectory(directory)
    await AtomicJsonFile.writeAsync(join(directory, 'brief.json'), parsed)
    return PassInbox.open(directory)
  }

  static async open(directory: string): Promise<PassInbox> {
    const checked = await PassInbox.checkedDirectory(directory)
    const [identity, channel, kind, attemptId] = PassInbox.parts(directory)
    const file = join(checked, 'brief.json')
    if (PathCompare.comparable(await realpath(file)) !== PathCompare.comparable(file))
      throw new Error('Pass brief redirects outside its owned path')
    const brief = briefSchema.parse(JSON.parse(await readFile(file, 'utf8')))
    if (brief.attemptId !== attemptId || brief.kind !== kind)
      throw new Error('Pass brief identity does not match its directory')
    return new PassInbox(resolve(directory), identity, channel, brief)
  }

  async brief(): Promise<PassBrief> { return structuredClone(this.value) }

  async append(event: PassEvent): Promise<number> {
    const parsed = PassInbox.validateEvent(event)
    const inbox = join(await PassInbox.checkedDirectory(this.directory), 'inbox')
    await mkdir(inbox, { recursive: true })
    if (PathCompare.comparable(await realpath(inbox)) !== PathCompare.comparable(inbox))
      throw new Error('Pass inbox redirects outside its owned path')
    const temporary = join(inbox, `tmp-${randomUUID()}.json`)
    await writeFile(temporary, JSON.stringify(parsed), { flag: 'wx', mode: 0o600 })
    try {
      let n = Math.max(0, ...(await readdir(inbox)).filter((name) => /^\d{6,}\.json$/.test(name)).map((name) => Number.parseInt(name))) + 1
      for (let retry = 0; retry < 100; retry++, n++) {
        try {
          await link(temporary, join(inbox, `${String(n).padStart(6, '0')}.json`))
          return n
        } catch (error) {
          if (ErrnoCode.of(error) !== 'EEXIST') throw error
        }
      }
      throw new Error('Pass inbox append contention exceeded 100 attempts')
    } finally { await unlink(temporary) }
  }

  async after(appliedThrough: number): Promise<{ n: number; event: PassEvent | null }[]> {
    const inbox = join(this.directory, 'inbox')
    let names: string[]
    try { names = await readdir(inbox) }
    catch (error) {
      if (ErrnoCode.of(error) === 'ENOENT') return []
      throw error
    }
    const numbered = names.filter((name) => /^\d{6,}\.json$/.test(name))
      .map((name) => ({ name, n: Number.parseInt(name) })).filter(({ n }) => n > appliedThrough).sort((a, b) => a.n - b.n)
    return Promise.all(numbered.map(async ({ name, n }) => {
      const raw = await readFile(join(inbox, name), 'utf8')
      try { return { n, event: PassInbox.validateEvent(JSON.parse(raw)) } }
      catch { return { n, event: null } }
    }))
  }

  private static parts(directory: string): [string, RuntimeChannel, string, string] {
    const parts = relative(resolve(OrchestratorPaths.machineRoot()), resolve(directory)).replace(/\\/g, '/').split('/')
    const [scope, identity, channel, snapins, kind, passes, attemptId] = parts
    if (parts.length !== 7 || scope !== 'orchestrator' || !identity || (channel !== 'production' && channel !== 'development')
      || snapins !== 'snapins' || !kind || passes !== 'passes' || !z.uuid().safeParse(attemptId).success)
      throw new Error('Path is not an owned snap-in pass directory')
    return [identity, channel, kind, attemptId!]
  }

  private static async checkedDirectory(directory: string): Promise<string> {
    PassInbox.parts(directory)
    const root = await realpath(OrchestratorPaths.machineRoot())
    const actual = await realpath(directory)
    const expected = join(root, relative(resolve(OrchestratorPaths.machineRoot()), resolve(directory)))
    if (PathCompare.comparable(actual) !== PathCompare.comparable(expected))
      throw new Error('Pass directory redirects outside its owned path')
    return actual
  }
}
