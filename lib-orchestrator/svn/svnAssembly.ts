import { createHash } from 'node:crypto'
import { createReadStream, type Stats } from 'node:fs'
import { lstat, readdir, readlink } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { XMLParser } from 'fast-xml-parser'
import { PathCompare } from '../shared/pathCompare'
import { PathPresence } from '../shared/pathPresence'
import type { CommandRunner } from '../shared/commandInvoker.types'
import { SvnExternalDefinitions } from './svnExternalDefinitions'
import { SvnWorktreeEvidence } from './svnWorktreeEvidence'
import { SvnNodeContent } from './svnNodeContent'

export interface SvnAssemblyNode {
  path: string
  content: string
  metadata: string
}

export interface SvnAssembly {
  format: 1
  content: string
  metadata: string
  nodes: SvnAssemblyNode[]
  incoming: string[]
}

interface StatusEntry {
  '@_path': string
  'wc-status'?: { '@_item': string; '@_props': string; [key: string]: unknown }
  'repos-status'?: { '@_item': string; '@_props': string }
}

interface PendingMount { path: string; pinned: boolean; expected?: string; revision?: string; url?: string }

/** The svn reads of one mount, started when the mount became known and awaited in the order the checks need them. */
interface MountReads {
  safe: Promise<void>
  disk: Promise<Stats>
  info: Promise<string>
  pinnedInfo: Promise<string> | undefined
  status: Promise<string>
  props: Promise<string>
}

/** One read: its bounded svn runner, the ancestors it already proved free of links, and every read it started. */
interface ReadScope {
  root: string
  svn: CommandRunner
  proven: Set<string>
  started: Promise<unknown>[]
}

/** At most `count` of the tasks run at once, the rest wait in order. */
class Slots {
  private free: number
  private readonly waiting: (() => void)[] = []

  constructor(count: number) { this.free = count }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free--
    else await new Promise<void>((resolve) => { this.waiting.push(resolve) })
    try { return await work() }
    finally {
      const next = this.waiting.shift()
      if (next === undefined) this.free++
      else next()
    }
  }
}

/** Local bytes and SVN metadata are separate: a proven own commit changes only the latter. */
export class SvnAssemblyReader {
  private readonly svn: CommandRunner
  private static readonly parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: false, htmlEntities: true,
    isArray: (name) => ['entry', 'target', 'property', 'changelist'].includes(name) })
  private static readonly privateNames = new Set(['.svn', '.git', '.checkpoints', '.worktrees'])
  // A sequential read of the Mirabia product (31 roots, 7,800 nodes) took 14 to 17 s; the svn calls of
  // the next mounts and the file reads of one mount overlap within these bounds (2026-10-30).
  static readonly svnProcessesConst = 6
  static readonly fileReadsConst = 32

  constructor(svn: CommandRunner) { this.svn = svn }

  async read(root: string, freshness = false, progress?: (mount: string, files: number) => void): Promise<SvnAssembly> {
    const nodes: SvnAssemblyNode[] = [], incoming: string[] = []
    const processes = new Slots(SvnAssemblyReader.svnProcessesConst)
    const scope: ReadScope = { root, svn: { run: (cwd, args, options) => processes.run(() => this.svn.run(cwd, args, options)) },
      proven: new Set(), started: [] }
    const pending: PendingMount[] = []
    const reads: MountReads[] = []
    const enqueue = (mount: PendingMount): void => {
      pending.push(mount)
      reads.push(this.readsOf(scope, mount, freshness))
    }
    enqueue({ path: root, pinned: false })
    const visited = new Set<string>()
    try {
      for (let index = 0; index < pending.length; index++) {
        const mount = pending[index], read = reads[index]
        progress?.(SvnWorktreeEvidence.relativeTo(root, mount.path), nodes.length)
        await read.safe
        const key = PathCompare.comparable(mount.path)
        if (visited.has(key)) throw new Error(`Repeated external mount: ${mount.path}`)
        visited.add(key)
        const disk = await read.disk
        const cwd = disk.isDirectory() ? mount.path : dirname(mount.path)
        const info = await read.info
        const entry = SvnWorktreeEvidence.infoEntries(info)[0]
        if (entry === undefined) throw new Error(`No SVN identity: ${mount.path}`)
        if (mount.expected !== undefined && decodeURI(entry.url) !== decodeURI(mount.expected))
          throw new Error(`External mapping differs from its working copy: ${mount.path}`)
        const pinnedRevision = !mount.pinned ? undefined : /^\d+$/.test(mount.revision!) ? Number(mount.revision)
          : SvnWorktreeEvidence.infoEntries(await read.pinnedInfo!)[0]?.revision
        if (mount.pinned && (pinnedRevision === undefined || entry.revision !== pinnedRevision))
          throw new Error(`Pinned external is not at its declared revision: ${mount.path}`)
        const uuid = SvnAssemblyReader.parser.parse(info).info?.entry?.[0]?.repository?.uuid
        if (typeof uuid !== 'string' || !uuid) throw new Error(`No repository UUID: ${mount.path}`)
        const own = SvnWorktreeEvidence.relativeTo(root, mount.path)
        nodes.push({ path: `@mount/${own}`, content: SvnAssemblyReader.hash([entry.url, entry.repository, uuid, entry.kind, mount.pinned]),
          metadata: String(entry.revision) })
        const status = await read.status
        const parsed = SvnAssemblyReader.parser.parse(status).status
        const entries = [...(parsed?.target ?? []).flatMap((row: { entry?: unknown[] }) => row.entry ?? []),
          ...(parsed?.changelist ?? []).flatMap((row: { entry?: unknown[] }) => row.entry ?? [])] as StatusEntry[]
        const properties = new Map<string, Array<[string, string, string]>>()
        const carriers: { path: string; externals: string }[] = []
        for (const carrier of SvnAssemblyReader.parser.parse(await read.props).properties?.target ?? []) {
          const path = resolve(cwd, carrier['@_path'])
          const values = (carrier.property ?? []).map((property: Record<string, string>) =>
            [property['@_name'], property['@_encoding'] ?? '', property['#text'] ?? ''] as [string, string, string]).sort(([a]: [string], [b]: [string]) => a.localeCompare(b))
          properties.set(PathCompare.comparable(path), values)
          const externals = values.find(([name]: [string]) => name === 'svn:externals')?.[2]
          if (externals !== undefined) carriers.push({ path, externals })
        }
        const carrierInfos = carriers.map((carrier) => carrier.path === mount.path ? null
          : SvnAssemblyReader.started(scope, this.run(scope.svn, cwd, ['info', '--xml', '--', `${relative(cwd, carrier.path).replace(/\\/g, '/')}@`])))
        for (const [position, carrier] of carriers.entries()) {
          const carrierInfo = carrierInfos[position] === null ? entry : SvnWorktreeEvidence.infoEntries(await carrierInfos[position]!)[0]
          for (const definition of SvnExternalDefinitions.parse(carrier.path, carrier.externals)) {
            const url = SvnExternalDefinitions.url(definition.url, carrierInfo.url, carrierInfo.repository)
            const peg = SvnExternalDefinitions.peg(url)
            enqueue({ path: definition.path, expected: peg === undefined ? url.replace(/@$/, '') : url.slice(0, url.lastIndexOf('@')),
              pinned: definition.revision !== undefined && definition.revision !== 'HEAD' || peg !== undefined && peg !== 'HEAD',
              revision: definition.revision ?? peg, url })
          }
        }
        const externalKeys = pending.slice(index + 1).map((child) => PathCompare.comparable(child.path))
        const absentDeletions = await PathPresence.missing(cwd, entries.filter((row) => row['wc-status']?.['@_item'] === 'deleted').map((row) => row['@_path']))
        const listed = new Set(entries.some((row) => row['wc-status']?.['@_item'] === 'deleted')
          ? entries.flatMap((row) => typeof row['@_path'] === 'string' ? [PathCompare.comparable(resolve(cwd, row['@_path']))] : []) : [])
        const rootKey = PathCompare.comparable(root)
        let reported = nodes.length
        const failure = await SvnAssemblyReader.inOrder(entries, SvnAssemblyReader.fileReadsConst, async (row) => {
          const found = await this.nodesOf(scope, { row, cwd, rootKey, externalKeys, properties, listed, absentDeletions, pinnedRevision })
          if (found.incoming !== undefined) incoming.push(found.incoming)
          nodes.push(...found.nodes)
          if (nodes.length - reported >= 128) { reported = nodes.length; progress?.(own, nodes.length) }
        })
        if (failure !== null) throw failure
        if (!disk.isDirectory() && !SvnWorktreeEvidence.registeredFileExternal(status)) throw new Error(`File external registration lost: ${own}`)
      }
    } finally {
      // Reads of mounts a failure left unread still run svn in the worktree; none may outlive the caller's lease.
      await Promise.allSettled(scope.started)
    }
    nodes.sort((left, right) => left.path.localeCompare(right.path))
    if (new Set(nodes.map((node) => node.path)).size !== nodes.length) throw new Error('Overlapping SVN assembly nodes')
    return { format: 1, nodes, incoming: [...new Set(incoming)].sort(),
      content: SvnAssemblyReader.hash(nodes.filter((node) => node.content !== '').map(({ path, content }) => [path, content])),
      metadata: SvnAssemblyReader.hash(nodes.map(({ path, metadata }) => [path, metadata])) }
  }

  static hash(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value, (_key, item) => item !== null && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)).digest('hex')
  }

  /**
   * Runs `work` for the items, at most `limit` at once, taking them in order. The answer is the error of
   * the first failing item in that order, as a loop over the items would have thrown it, or null. Every
   * item before it was taken, and every taken item has ended by then.
   */
  private static async inOrder<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<unknown> {
    const failures = new Map<number, unknown>()
    let next = 0
    const worker = async (): Promise<void> => {
      while (failures.size === 0 && next < items.length) {
        const index = next++
        try { await work(items[index]) }
        catch (error: unknown) { failures.set(index, error) }
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
    return failures.size === 0 ? null : failures.get(Math.min(...failures.keys()))
  }

  /** A read the loop awaits at its turn, or the drain after a failure; none rejects unobserved. */
  private static started<T>(scope: ReadScope, promise: Promise<T>): Promise<T> {
    scope.started.push(promise)
    void promise.catch(() => {})
    return promise
  }

  private readsOf(scope: ReadScope, mount: PendingMount, freshness: boolean): MountReads {
    const safe = SvnAssemblyReader.started(scope, this.safePath(scope, mount.path))
    const disk = SvnAssemblyReader.started(scope, safe.then(() => lstat(mount.path)))
    const where = disk.then((stat) => stat.isDirectory() ? { cwd: mount.path, target: '.' }
      : { cwd: dirname(mount.path), target: relative(dirname(mount.path), mount.path).replace(/\\/g, '/') })
    const run = (args: (target: string) => string[]) => SvnAssemblyReader.started(scope, where.then(({ cwd, target }) => this.run(scope.svn, cwd, args(target))))
    return { safe, disk,
      info: run((target) => ['info', '--xml', '--', `${target}@`]),
      pinnedInfo: mount.pinned && !/^\d+$/.test(mount.revision!) ? run(() => ['info', '--xml', '-r', mount.revision!, '--', mount.url!]) : undefined,
      status: run((target) => ['status', '--xml', '--verbose', '--ignore-externals', ...(freshness && !mount.pinned ? ['--show-updates'] : []), '--', `${target}@`]),
      props: run((target) => ['proplist', '--xml', '--verbose', '--depth', 'infinity', '--', `${target}@`]) }
  }

  private async nodesOf(scope: ReadScope, input: { row: StatusEntry; cwd: string; rootKey: string; externalKeys: readonly string[];
    properties: ReadonlyMap<string, Array<[string, string, string]>>; listed: ReadonlySet<string>; absentDeletions: ReadonlySet<string>;
    pinnedRevision: number | undefined }): Promise<{ nodes: SvnAssemblyNode[]; incoming?: string }> {
    const { row, cwd, rootKey } = input, root = scope.root
    if (typeof row['@_path'] !== 'string') throw new Error('SVN returned a node without a path')
    const path = resolve(cwd, row['@_path']), status = row['wc-status'], key = PathCompare.comparable(path)
    if (key !== rootKey && !key.startsWith(`${rootKey}/`)) throw new Error('SVN returned a path outside the worktree')
    const name = SvnWorktreeEvidence.relativeTo(root, path)
    if (name.split('/').some((part) => SvnAssemblyReader.privateNames.has(part))) return { nodes: [] }
    if (input.externalKeys.some((child) => key === child || key.startsWith(`${child}/`))) return { nodes: [] }
    const incoming = row['repos-status'] && (row['repos-status']['@_item'] !== 'none' || !['none', 'normal'].includes(row['repos-status']['@_props'])) ? name : undefined
    const found = (nodes: SvnAssemblyNode[]) => incoming === undefined ? { nodes } : { nodes, incoming }
    // status -u also lists repository additions that have no local filesystem node yet.
    if (status === undefined || status['@_item'] === 'none') return found([])
    if (input.pinnedRevision !== undefined && status['@_revision'] !== undefined && Number(status['@_revision']) !== input.pinnedRevision)
      throw new Error(`Pinned external contains a different BASE revision: ${name}`)
    if (status['@_switched'] === 'true' && status['@_file-external'] !== 'true') throw new Error(`Switched node: ${name}`)
    if (['conflicted', 'obstructed', 'incomplete', 'missing'].includes(status['@_item']) || status['@_tree-conflicted'] === 'true' || status['@_props'] === 'conflicted')
      throw new Error(`Unsettled SVN node: ${name}`)
    if (status['@_item'] === 'ignored' || status['@_item'] === 'external') return found([])
    const metadata = SvnAssemblyReader.hash(status)
    if (status['@_item'] === 'deleted') {
      const leftover = input.absentDeletions.has(row['@_path']) ? null
        : await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
      let content = ''
      if (leftover !== null && !leftover.isDirectory()) {
        await this.safePath(scope, path)
        if (!leftover.isFile()) throw new Error(`Scheduled deletion still has a linked or special node: ${name}`)
        content = await SvnAssemblyReader.fileHash(path)
        const base = await SvnNodeContent.exported(scope.svn, cwd, `${relative(cwd, path).replace(/\\/g, '/')}@`, 'BASE', true)
        if (content !== base) throw new Error(`Scheduled deletion ${name} contains new working bytes. Preserve this file and replace the deletion with an add/replace, or move the local file outside the tested application before preparing again.`)
      }
      if (leftover?.isDirectory())
        for (const child of await readdir(path))
          if (!input.listed.has(PathCompare.comparable(join(path, child))))
            throw new Error(`Scheduled deletion ${name} contains an unversioned child: ${child}. Preserve and move it outside the tested application before preparing again.`)
      return found([{ path: name, content, metadata }])
    }
    await this.safePath(scope, path)
    const node = await lstat(path)
    if (node.isSymbolicLink()) throw new Error(`Linked source cannot be validated: ${name}`)
    const properties = input.properties.get(key)
    const translated = properties?.some(([name]) => name === 'svn:keywords' || name === 'svn:eol-style')
    const content = node.isDirectory() ? 'directory' : translated
      ? await SvnNodeContent.exported(scope.svn, cwd, `${relative(cwd, path).replace(/\\/g, '/')}@`) : await SvnAssemblyReader.fileHash(path)
    const nodes: SvnAssemblyNode[] = [{ path: name, content: SvnAssemblyReader.hash([content, properties ?? []]), metadata }]
    if (status['@_item'] === 'unversioned' && node.isDirectory()) await this.untracked(root, path, nodes)
    return found(nodes)
  }

  private static async fileHash(path: string): Promise<string> {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    return hash.digest('hex')
  }

  /**
   * No node from `path` up to the root is a link. An ancestor this read already proved is not read
   * again: about 50,000 lstat calls of 7,800 nodes became one per directory.
   */
  private async safePath(scope: ReadScope, path: string): Promise<void> {
    if (!PathCompare.isInside(scope.root, path)) throw new Error(`Path escapes worktree: ${path}`)
    const rootKey = PathCompare.comparable(scope.root)
    const walked: string[] = []
    for (let ancestor = path; ; ancestor = dirname(ancestor)) {
      const key = PathCompare.comparable(ancestor)
      if (scope.proven.has(key)) break
      const node = await lstat(ancestor)
      if (node.isSymbolicLink()) throw new Error(`Linked source cannot be validated: ${ancestor} -> ${await readlink(ancestor)}`)
      walked.push(key)
      if (key === rootKey) break
    }
    for (const key of walked) scope.proven.add(key)
  }

  private async untracked(root: string, directory: string, nodes: SvnAssemblyNode[]): Promise<void> {
    for (const name of await readdir(directory)) {
      if (SvnAssemblyReader.privateNames.has(name)) continue
      const path = resolve(directory, name), disk = await lstat(path)
      if (disk.isSymbolicLink()) throw new Error(`Linked untracked source: ${path}`)
      nodes.push({ path: SvnWorktreeEvidence.relativeTo(root, path), metadata: 'unversioned',
        content: SvnAssemblyReader.hash([disk.isDirectory() ? 'directory' : await SvnAssemblyReader.fileHash(path), []]) })
      if (disk.isDirectory()) await this.untracked(root, path, nodes)
    }
  }

  private async run(svn: CommandRunner, cwd: string, args: string[]): Promise<string> {
    if (args.some((arg) => !SvnWorktreeEvidence.takesArgument(arg)))
      throw new Error('SVN cannot safely address a non-ASCII path on this platform: svn.exe converts arguments through the Windows ANSI code page and may address a different file. Rename the path using ASCII characters, or publish it through TortoiseSVN and prepare again.')
    const outcome = await svn.run(cwd, [args[0], '--non-interactive', ...args.slice(1)])
    if (outcome.failure !== null || outcome.code !== 0) throw new Error(outcome.stderr || `SVN ${args[0]} failed`)
    return outcome.stdout
  }
}
