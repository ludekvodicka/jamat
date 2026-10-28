import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
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

/** Local bytes and SVN metadata are separate: a proven own commit changes only the latter. */
export class SvnAssemblyReader {
  private readonly svn: CommandRunner
  private static readonly parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: false, htmlEntities: true,
    isArray: (name) => ['entry', 'target', 'property', 'changelist'].includes(name) })
  private static readonly privateNames = new Set(['.svn', '.git', '.checkpoints', '.worktrees'])

  constructor(svn: CommandRunner) { this.svn = svn }

  async read(root: string, freshness = false, progress?: (mount: string, files: number) => void): Promise<SvnAssembly> {
    const nodes: SvnAssemblyNode[] = [], incoming: string[] = []
    const pending: { path: string; pinned: boolean; expected?: string; revision?: string; url?: string }[] = [{ path: root, pinned: false }]
    const visited = new Set<string>()
    for (let index = 0; index < pending.length; index++) {
      const mount = pending[index]
      progress?.(SvnWorktreeEvidence.relativeTo(root, mount.path), nodes.length)
      await this.safePath(root, mount.path)
      const key = PathCompare.comparable(mount.path)
      if (visited.has(key)) throw new Error(`Repeated external mount: ${mount.path}`)
      visited.add(key)
      const disk = await lstat(mount.path)
      const cwd = disk.isDirectory() ? mount.path : dirname(mount.path)
      const target = disk.isDirectory() ? '.' : relative(cwd, mount.path).replace(/\\/g, '/')
      const info = await this.run(cwd, ['info', '--xml', '--', `${target}@`])
      const entry = SvnWorktreeEvidence.infoEntries(info)[0]
      if (entry === undefined) throw new Error(`No SVN identity: ${mount.path}`)
      if (mount.expected !== undefined && decodeURI(entry.url) !== decodeURI(mount.expected))
        throw new Error(`External mapping differs from its working copy: ${mount.path}`)
      const pinnedRevision = !mount.pinned ? undefined : /^\d+$/.test(mount.revision!) ? Number(mount.revision)
        : SvnWorktreeEvidence.infoEntries(await this.run(cwd, ['info', '--xml', '-r', mount.revision!, '--', mount.url!]))[0]?.revision
      if (mount.pinned && (pinnedRevision === undefined || entry.revision !== pinnedRevision))
        throw new Error(`Pinned external is not at its declared revision: ${mount.path}`)
      const uuid = SvnAssemblyReader.parser.parse(info).info?.entry?.[0]?.repository?.uuid
      if (typeof uuid !== 'string' || !uuid) throw new Error(`No repository UUID: ${mount.path}`)
      const own = SvnWorktreeEvidence.relativeTo(root, mount.path)
      nodes.push({ path: `@mount/${own}`, content: SvnAssemblyReader.hash([entry.url, entry.repository, uuid, entry.kind, mount.pinned]),
        metadata: String(entry.revision) })
      const status = await this.run(cwd, ['status', '--xml', '--verbose', '--ignore-externals', ...(freshness && !mount.pinned ? ['--show-updates'] : []), '--', `${target}@`])
      const parsed = SvnAssemblyReader.parser.parse(status).status
      const entries = [...(parsed?.target ?? []).flatMap((row: { entry?: unknown[] }) => row.entry ?? []),
        ...(parsed?.changelist ?? []).flatMap((row: { entry?: unknown[] }) => row.entry ?? [])] as StatusEntry[]
      const propsXml = await this.run(cwd, ['proplist', '--xml', '--verbose', '--depth', 'infinity', '--', `${target}@`])
      const properties = new Map<string, Array<[string, string, string]>>()
      for (const carrier of SvnAssemblyReader.parser.parse(propsXml).properties?.target ?? []) {
        const path = resolve(cwd, carrier['@_path'])
        const values = (carrier.property ?? []).map((property: Record<string, string>) =>
          [property['@_name'], property['@_encoding'] ?? '', property['#text'] ?? ''] as [string, string, string]).sort(([a]: [string], [b]: [string]) => a.localeCompare(b))
        properties.set(PathCompare.comparable(path), values)
        const externals = values.find(([name]: [string]) => name === 'svn:externals')?.[2]
        if (externals !== undefined) {
          const carrierInfo = path === mount.path ? entry : SvnWorktreeEvidence.infoEntries(await this.run(cwd, ['info', '--xml', '--', `${relative(cwd, path).replace(/\\/g, '/')}@`]))[0]
          for (const definition of SvnExternalDefinitions.parse(path, externals)) {
            const url = SvnExternalDefinitions.url(definition.url, carrierInfo.url, carrierInfo.repository)
            const peg = SvnExternalDefinitions.peg(url)
            pending.push({ path: definition.path, expected: peg === undefined ? url.replace(/@$/, '') : url.slice(0, url.lastIndexOf('@')),
              pinned: definition.revision !== undefined && definition.revision !== 'HEAD' || peg !== undefined && peg !== 'HEAD',
              revision: definition.revision ?? peg, url })
          }
        }
      }
      const externalPaths = pending.slice(index + 1).map((child) => child.path)
      const absentDeletions = await PathPresence.missing(cwd, entries.filter((row) => row['wc-status']?.['@_item'] === 'deleted').map((row) => row['@_path']))
      for (const row of entries) {
        if (typeof row['@_path'] !== 'string') throw new Error('SVN returned a node without a path')
        const path = resolve(cwd, row['@_path']), status = row['wc-status']
        if (!PathCompare.isInside(root, path)) throw new Error('SVN returned a path outside the worktree')
        const name = SvnWorktreeEvidence.relativeTo(root, path)
        if (name.split('/').some((part) => SvnAssemblyReader.privateNames.has(part))) continue
        if (externalPaths.some((child) => PathCompare.isInside(child, path))) continue
        if (row['repos-status'] && (row['repos-status']['@_item'] !== 'none' || !['none', 'normal'].includes(row['repos-status']['@_props']))) incoming.push(name)
        // status -u also lists repository additions that have no local filesystem node yet.
        if (status === undefined || status['@_item'] === 'none') continue
        if (pinnedRevision !== undefined && status['@_revision'] !== undefined && Number(status['@_revision']) !== pinnedRevision)
          throw new Error(`Pinned external contains a different BASE revision: ${name}`)
        if (status['@_switched'] === 'true' && status['@_file-external'] !== 'true') throw new Error(`Switched node: ${name}`)
        if (['conflicted', 'obstructed', 'incomplete', 'missing'].includes(status['@_item']) || status['@_tree-conflicted'] === 'true' || status['@_props'] === 'conflicted')
          throw new Error(`Unsettled SVN node: ${name}`)
        if (status['@_item'] === 'ignored' || status['@_item'] === 'external') continue
        const metadata = SvnAssemblyReader.hash(status)
        if (status['@_item'] === 'deleted') {
          const leftover = absentDeletions.has(row['@_path']) ? null
            : await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
          let content = ''
          if (leftover !== null && !leftover.isDirectory()) {
            await this.safePath(root, path)
            if (!leftover.isFile()) throw new Error(`Scheduled deletion still has a linked or special node: ${name}`)
            content = await SvnAssemblyReader.fileHash(path)
            const base = await SvnNodeContent.exported(this.svn, cwd, `${relative(cwd, path).replace(/\\/g, '/')}@`, 'BASE', true)
            if (content !== base) throw new Error(`Scheduled deletion ${name} contains new working bytes. Preserve this file and replace the deletion with an add/replace, or move the local file outside the tested application before preparing again.`)
          }
          if (leftover?.isDirectory())
            for (const child of await readdir(path))
              if (!entries.some((entry) => PathCompare.comparable(resolve(cwd, entry['@_path'])) === PathCompare.comparable(join(path, child))))
                throw new Error(`Scheduled deletion ${name} contains an unversioned child: ${child}. Preserve and move it outside the tested application before preparing again.`)
          nodes.push({ path: name, content, metadata })
          continue
        }
        await this.safePath(root, path)
        const node = await lstat(path)
        if (node.isSymbolicLink()) throw new Error(`Linked source cannot be validated: ${name}`)
        const translated = properties.get(PathCompare.comparable(path))?.some(([name]) => name === 'svn:keywords' || name === 'svn:eol-style')
        const content = node.isDirectory() ? 'directory' : translated
          ? await SvnNodeContent.exported(this.svn, cwd, `${relative(cwd, path).replace(/\\/g, '/')}@`) : await SvnAssemblyReader.fileHash(path)
        nodes.push({ path: name, content: SvnAssemblyReader.hash([content, properties.get(PathCompare.comparable(path)) ?? []]), metadata })
        if (nodes.length % 128 === 0) progress?.(own, nodes.length)
        if (status['@_item'] === 'unversioned' && node.isDirectory()) await this.untracked(root, path, nodes)
      }
      if (!disk.isDirectory() && !SvnWorktreeEvidence.registeredFileExternal(status)) throw new Error(`File external registration lost: ${own}`)
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

  private static async fileHash(path: string): Promise<string> {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    return hash.digest('hex')
  }

  private async safePath(root: string, path: string): Promise<void> {
    if (!PathCompare.isInside(root, path)) throw new Error(`Path escapes worktree: ${path}`)
    for (let ancestor = path; ; ancestor = dirname(ancestor)) {
      const node = await lstat(ancestor)
      if (node.isSymbolicLink()) throw new Error(`Linked source cannot be validated: ${ancestor} -> ${await readlink(ancestor)}`)
      if (PathCompare.comparable(ancestor) === PathCompare.comparable(root)) break
    }
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

  private async run(cwd: string, args: string[]): Promise<string> {
    if (args.some((arg) => !SvnWorktreeEvidence.takesArgument(arg)))
      throw new Error('SVN cannot safely address a non-ASCII path on this platform: svn.exe converts arguments through the Windows ANSI code page and may address a different file. Rename the path using ASCII characters, or publish it through TortoiseSVN and prepare again.')
    const outcome = await this.svn.run(cwd, [args[0], '--non-interactive', ...args.slice(1)])
    if (outcome.failure !== null || outcome.code !== 0) throw new Error(outcome.stderr || `SVN ${args[0]} failed`)
    return outcome.stdout
  }
}
