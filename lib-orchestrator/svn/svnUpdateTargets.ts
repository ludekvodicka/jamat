import { lstat } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import type { CommandRunner } from '../shared/commandInvoker.types'
import { PathCompare } from '../shared/pathCompare'
import { SvnExternalDefinitions } from './svnExternalDefinitions'
import { SvnWorktreeEvidence } from './svnWorktreeEvidence'
import type { SvnInfoEntry } from './svn.types'

export interface SvnUpdateTarget {
  path: string
  url: string
  repository: string
  revision: number
  kind: 'file' | 'dir'
  pinned: boolean
}

export interface SvnUpdateSnapshot {
  properties: Record<string, string>
  localMappingChanges: boolean
  children: SvnUpdateTarget[]
  missing: string[]
  mismatched: string[]
  protectedMounts?: Array<{ path: string; url: string; repository: string }>
}

export class SvnUpdateTargets {
  private readonly svn: CommandRunner

  constructor(svn: CommandRunner) { this.svn = svn }

  async owner(path: string, revision: number): Promise<SvnUpdateTarget> {
    const info = await this.info(path, '.')
    return { path, url: info.url, repository: info.repository, revision, kind: info.kind, pinned: false }
  }

  async snapshot(target: SvnUpdateTarget, discover = true, protect = false): Promise<SvnUpdateSnapshot> {
    if (target.kind === 'file') return { properties: {}, localMappingChanges: false, children: [], missing: [], mismatched: [] }
    const properties = SvnExternalDefinitions.properties(await this.run(target.path, ['propget', 'svn:externals', '-R', '--xml', '--', '.']), target.path)
    const base = SvnExternalDefinitions.properties(await this.run(target.path, ['propget', 'svn:externals', '-R', '--xml', '-r', 'BASE', '--', '.']), target.path)
    const children: SvnUpdateTarget[] = [], missing: string[] = [], mismatched: string[] = []
    const protectedMounts: NonNullable<SvnUpdateSnapshot['protectedMounts']> = []
    if (protect) for (const definitions of [base, properties]) for (const [carrier, value] of Object.entries(definitions))
      for (const definition of SvnExternalDefinitions.parse(carrier, value)) {
        if (protectedMounts.some((mount) => PathCompare.comparable(mount.path) === PathCompare.comparable(definition.path))) continue
        const disk = await lstat(definition.path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
        if (disk === null) continue
        if (disk.isSymbolicLink()) throw new Error(`External mount is a link: ${definition.path}`)
        const cwd = disk.isDirectory() ? definition.path : dirname(definition.path)
        const argument = disk.isDirectory() ? '.' : `${relative(cwd, definition.path)}@`
        const local = await this.info(cwd, argument)
        const status = SvnWorktreeEvidence.statusRows(await this.run(cwd, ['status', '--xml', '--', argument]), cwd)
        if (status.some((row) => row.conflict || row.kind !== 'clean' && row.kind !== 'external'))
          protectedMounts.push({ path: definition.path, url: local.url, repository: local.repository })
      }
    if (!discover) return { properties, localMappingChanges: JSON.stringify(properties) !== JSON.stringify(base), children, missing, mismatched, protectedMounts }
    for (const [carrier, value] of Object.entries(properties)) {
      const carrierInfo = await this.info(target.path, `${relative(target.path, carrier) || '.'}@`)
      for (const definition of SvnExternalDefinitions.parse(carrier, value)) {
        const url = SvnExternalDefinitions.url(definition.url, carrierInfo.url, carrierInfo.repository)
        const revision = definition.revision ?? SvnExternalDefinitions.peg(url) ?? 'HEAD'
        const incoming = await this.info(target.path, url, revision)
        const child = { path: definition.path, url: incoming.url, repository: incoming.repository, revision: incoming.revision,
          kind: incoming.kind, pinned: definition.revision !== undefined || SvnExternalDefinitions.peg(url) !== undefined }
        if (children.some((row) => PathCompare.comparable(row.path) === PathCompare.comparable(child.path)))
          throw new Error(`More than one external owns ${child.path}`)
        children.push(child)
        const disk = await lstat(child.path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
        if (disk === null) { missing.push(child.path); continue }
        if (disk.isSymbolicLink()) throw new Error(`External mount is a link: ${child.path}`)
        const local = await this.localInfo(child)
        if (local.url !== child.url || local.repository !== child.repository || local.kind !== child.kind) mismatched.push(child.path)
        if (child.kind === 'file' && !child.pinned) child.revision = local.revision
      }
    }
    return { properties, localMappingChanges: JSON.stringify(properties) !== JSON.stringify(base),
      children: children.sort((left, right) => left.path.localeCompare(right.path)), missing, mismatched, protectedMounts }
  }

  /** `older`: absolute paths conflicted before the update; svn skips them and everything below them. */
  async verify(target: SvnUpdateTarget, revision = true, older: readonly string[] = []): Promise<void> {
    for (let path = target.path; dirname(path) !== path; path = dirname(path))
      if ((await lstat(path)).isSymbolicLink()) throw new Error(`Update target crosses a link: ${path}`)
    const info = await this.localInfo(target)
    if (info.url !== target.url || info.repository !== target.repository || info.kind !== target.kind || revision && info.revision !== target.revision)
      throw new Error(`Update did not reach the expected URL and r${target.revision}: ${target.path}`)
    if (revision && target.kind === 'dir') {
      const status = await this.run(target.path, ['status', '-v', '--xml', '--ignore-externals', '--', '.'])
      const skipped = SvnWorktreeEvidence.updateProblems(status, target.path, target.revision)
        .filter((path) => !older.some((conflicted) => PathCompare.isInside(conflicted, resolve(target.path, path))))
      if (skipped.length > 0) throw new Error(`Update left skipped or switched paths in ${target.path}: ${skipped.join(', ')}`)
    }
    else if (target.kind === 'file') {
      const status = await this.run(dirname(target.path), ['status', '-v', '--xml', '--depth', 'empty', '--', `${relative(dirname(target.path), target.path)}@`])
      if (!SvnWorktreeEvidence.registeredFileExternal(status)) throw new Error(`SVN lost file-external registration: ${target.path}`)
    }
    else if (target.kind !== 'dir') throw new Error(`Unknown update target kind: ${JSON.stringify(target.kind satisfies never)}`)
  }

  private localInfo(target: SvnUpdateTarget): Promise<SvnInfoEntry> {
    return target.kind === 'dir' ? this.info(target.path, '.') : this.info(dirname(target.path), `${relative(dirname(target.path), target.path)}@`)
  }

  private async info(cwd: string, target: string, revision?: string): Promise<SvnInfoEntry> {
    const xml = await this.run(cwd, ['info', '--xml', ...revision === undefined ? [] : ['-r', revision], '--', target])
    const entries = SvnWorktreeEvidence.infoEntries(xml)
    if (entries.length !== 1) throw new Error(`svn info did not identify exactly one target: ${target}`)
    return entries[0]
  }

  private async run(cwd: string, args: string[]): Promise<string> {
    if (!args.every(SvnWorktreeEvidence.takesArgument)) throw new Error('svn cannot preserve a non-ASCII update target')
    const result = await this.svn.run(cwd, args)
    if (result.code !== 0 || result.failure !== null) throw new Error(result.stderr || result.stdout || String(result.failure))
    return result.stdout
  }
}
