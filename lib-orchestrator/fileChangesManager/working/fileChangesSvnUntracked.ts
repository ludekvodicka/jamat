import { glob, lstat, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'

import { XMLParser } from 'fast-xml-parser'

import type { GitCommandRunner } from '../../git/git.types'
import { GitCheckpointStore } from '../../git/gitCheckpointStore'
import { GitInvoker } from '../../git/gitInvoker'
import type { CommandRunner } from '../../shared/commandInvoker.types'
import { JsonShape } from '../../shared/jsonShape'
import { PathCompare } from '../../shared/pathCompare'
import { SvnInvoker } from '../../svn/svnInvoker'
import { FileChangesLimits } from '../fileChangesLimits'
import type { FileChangesVcsEntry } from '../vcs/fileChangesVcs.types'

export interface FileChangesSvnUntrackedDeps {
  git: GitCommandRunner
  checkpointStore: Pick<GitCheckpointStore, 'existingContextOf'>
  svn: CommandRunner
  configFile: string
}

export class FileChangesSvnUntracked {
  private static readonly defaultIgnoresConst = '*.o *.lo *.la *.al .libs *.so *.so.[0-9]* *.a *.pyc *.pyo *.rej *~ #*# .#* .*.swp .DS_Store'
  private readonly deps: FileChangesSvnUntrackedDeps

  constructor(deps?: FileChangesSvnUntrackedDeps) {
    const git = new GitInvoker({ timeoutMilliseconds: FileChangesLimits.readTimeoutMilliseconds })
    this.deps = deps ?? {
      git,
      checkpointStore: new GitCheckpointStore(git),
      svn: new SvnInvoker({ timeoutMilliseconds: FileChangesLimits.readTimeoutMilliseconds }),
      configFile: process.platform === 'win32'
        ? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Subversion', 'config')
        : join(homedir(), '.subversion', 'config'),
    }
  }

  async expand(entries: readonly FileChangesVcsEntry[]): Promise<readonly FileChangesVcsEntry[]> {
    const expanded = new Map(entries.map((entry) => [PathCompare.comparable(entry.absolutePath), entry]))
    FileChangesSvnUntracked.checkLimit(expanded.size)
    for (const directory of entries) {
      if (directory.status !== 'untracked' || directory.nodeKind !== 'directory') continue
      if (!(await lstat(directory.absolutePath)).isDirectory())
        throw new Error(`${directory.absolutePath} is no longer a regular directory; reload the list`)
      const paths = await this.gitPaths(directory.absolutePath)
      const children = paths ?? await this.diskPaths(directory.absolutePath)
      for (const path of children) {
        if (!PathCompare.isInside(directory.absolutePath, path)) throw new Error('An untracked path is outside its directory')
        const key = PathCompare.comparable(path)
        if (expanded.has(key)) continue
        const node = await lstat(path)
        expanded.set(key, {
          ...directory,
          absolutePath: path,
          repositoryPath: `${directory.repositoryPath}/${relative(directory.absolutePath, path).replace(/\\/g, '/')}`,
          nodeKind: node.isDirectory() ? 'directory' : 'file',
        })
        FileChangesSvnUntracked.checkLimit(expanded.size)
      }
    }
    return [...expanded.values()]
  }

  private async gitPaths(directory: string): Promise<readonly string[] | null> {
    const own = await this.deps.git.run(directory, ['rev-parse', '--show-toplevel'])
    let args: readonly string[]
    if (own.code === 0 && own.failure === null) args = []
    else {
      if (own.failure !== null && own.failure !== 'git-missing') throw new Error(own.stderr || 'Git discovery failed')
      const stored = await this.deps.checkpointStore.existingContextOf(directory)
      if (!stored.ok) throw new Error(stored.detail)
      if (stored.value === null) return null
      args = stored.value.gitDirArgs
    }
    const listed = await this.deps.git.run(directory, [...args, 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.'])
    if (listed.failure !== null || listed.code !== 0) throw new Error(listed.stderr || 'Git could not enumerate the new directory')
    const paths = new Set<string>()
    for (const name of listed.stdout.split('\0').filter(Boolean)) {
      let path = resolve(directory, name)
      if (!PathCompare.isInside(directory, path)) throw new Error('Git returned a path outside the new directory')
      const node = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (node === null) continue
      while (PathCompare.comparable(path) !== PathCompare.comparable(directory)) {
        paths.add(path)
        FileChangesSvnUntracked.checkLimit(paths.size)
        path = dirname(path)
      }
    }
    return [...paths].sort((left, right) => left.length - right.length)
  }

  private async diskPaths(directory: string): Promise<readonly string[]> {
    const config = await readFile(this.deps.configFile, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return ''
      throw error
    })
    const section = /^\[miscellany\][\s\S]*?(?=^\[|$(?![\s\S]))/mi.exec(config)?.[0] ?? ''
    const configured = /^global-ignores\s*=([^\r\n]*)/mi.exec(section)?.[1]
    const ignores = (configured ?? FileChangesSvnUntracked.defaultIgnoresConst).split(/\s+/).filter(Boolean)
    const inherited = await this.deps.svn.run(dirname(directory), ['propget', 'svn:global-ignores', '--show-inherited-props', '--xml', '--non-interactive', '--', `${dirname(directory)}@`])
    if (inherited.failure !== null || inherited.code !== 0) throw new Error(inherited.stderr || 'SVN could not read inherited ignore rules')
    const properties = JsonShape.record(new XMLParser({ ignoreAttributes: false, parseTagValue: false }).parse(inherited.stdout))?.properties
    for (const value of Object.values(JsonShape.record(properties) ?? {}))
      for (const target of Array.isArray(value) ? value : [value]) {
        for (const property of Object.values(JsonShape.record(target) ?? {}))
          for (const item of Array.isArray(property) ? property : [property]) {
            const text = JsonShape.record(item)?.['#text']
            if (typeof text === 'string') ignores.push(...text.split(/\r?\n/).filter(Boolean))
          }
      }
    const paths: string[] = []
    const pending = [directory]
    for (let index = 0; index < pending.length; index++)
      for await (const name of glob(['*', '.*'], { cwd: pending[index], exclude: ['.svn', ...ignores] })) {
        const path = join(pending[index], name)
        const node = await lstat(path)
        paths.push(path)
        FileChangesSvnUntracked.checkLimit(paths.length)
        if (node.isDirectory()) pending.push(path)
      }
    return paths
  }

  private static checkLimit(count: number): void {
    if (count > FileChangesLimits.listingEntriesMax)
      throw new Error(`The commit list exceeds ${FileChangesLimits.listingEntriesMax} entries; open a smaller directory`)
  }
}
