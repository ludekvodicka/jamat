import { lstat } from 'node:fs/promises'
import { relative, resolve } from 'node:path'

import { XMLParser } from 'fast-xml-parser'

import type { CommandRunner } from '../../shared/commandInvoker.types'
import { JsonShape } from '../../shared/jsonShape'
import { PathCompare } from '../../shared/pathCompare'
import { SvnInvoker } from '../../svn/svnInvoker'
import { FileChangesLimits } from '../fileChangesLimits'
import type { FileChangesVcsEntry } from '../vcs/fileChangesVcs.types'

export interface FileChangesSvnCopiedDeps {
  svn: CommandRunner
}

/**
 * The files a copied directory carries, which `svn status` does not mention.
 *
 * `svn copy utils/react react` schedules ONE node: plain status prints `A +` for `react` and
 * nothing for the four files under it, because none of them is modified against the copy they came
 * from. The commit publishes them all - the server copies the subtree from the copyfrom source -
 * so the pane was asking a person to approve four files it never showed them. TortoiseSVN walks
 * the added tree for exactly this reason and draws them as `normal (+)`.
 *
 * A plain `svn add dir` needs none of this: it schedules every child on its own, so they were
 * already in the status the pane read. The expansion below covers both and adds nothing twice,
 * because a path already present keeps the status it arrived with. That matters for the one case
 * where such a row is not decoration: a file MODIFIED after the copy is a target of its own, and
 * `--depth empty` on the parent would not carry its edit.
 */
export class FileChangesSvnCopied {
  private readonly deps: FileChangesSvnCopiedDeps

  constructor(deps?: FileChangesSvnCopiedDeps) {
    this.deps = deps ?? { svn: new SvnInvoker({ timeoutMilliseconds: FileChangesLimits.readTimeoutMilliseconds }) }
  }

  async expand(entries: readonly FileChangesVcsEntry[]): Promise<readonly FileChangesVcsEntry[]> {
    const expanded = new Map(entries.map((entry) => [PathCompare.comparable(entry.absolutePath), entry]))
    FileChangesSvnCopied.checkLimit(expanded.size)
    for (const directory of entries) {
      if (directory.status !== 'added' || directory.nodeKind !== 'directory') continue
      for (const path of await this.contentsOf(directory.absolutePath)) {
        if (!PathCompare.isInside(directory.absolutePath, path))
          throw new Error('SVN returned a copied path outside its directory')
        const key = PathCompare.comparable(path)
        if (expanded.has(key)) continue
        expanded.set(key, {
          ...directory,
          absolutePath: path,
          repositoryPath: `${directory.repositoryPath}/${relative(directory.absolutePath, path).replace(/\\/g, '/')}`,
          nodeKind: (await lstat(path)).isDirectory() ? 'directory' : 'file',
          status: 'copied',
        })
        FileChangesSvnCopied.checkLimit(expanded.size)
      }
    }
    return [...expanded.values()]
  }

  /**
   * `--verbose` here and nowhere else. The reader refuses it over a whole working copy, where it
   * prints an entry per versioned node and overran the output ceiling on forty thousand files.
   * Scoped to one directory being ADDED, the versioned nodes under it are precisely the ones
   * nobody has published yet, and the listing ceiling still bounds what comes back.
   */
  private async contentsOf(directory: string): Promise<readonly string[]> {
    const outcome = await this.deps.svn.run(directory, [
      'status', '--xml', '--verbose', '--non-interactive', '--ignore-externals',
      '--depth', 'infinity', '--', `${directory}@`,
    ])
    if (outcome.failure !== null || outcome.code !== 0)
      throw new Error(outcome.stderr.trim() || 'SVN could not list the copied directory')
    const parsed = JsonShape.record(new XMLParser({ ignoreAttributes: false, parseTagValue: false,
      isArray: (name) => name === 'entry' || name === 'target' }).parse(outcome.stdout))
    const targets = JsonShape.record(parsed?.status)?.target
    if (!Array.isArray(targets)) throw new Error('SVN returned an invalid copied status')
    const paths: string[] = []
    for (const target of targets) {
      const entries = JsonShape.record(target)?.entry ?? []
      if (!Array.isArray(entries)) throw new Error('SVN returned invalid copied status entries')
      for (const value of entries) {
        const entry = JsonShape.record(value)
        const working = JsonShape.record(entry?.['wc-status'])
        if (entry === null || working === null || typeof entry['@_path'] !== 'string')
          throw new Error('SVN returned an invalid copied status entry')
        // Only what the copy brought along untouched. Anything else - a modification, a delete, a
        // nested add - is its own status entry and reached the pane as a target of its own.
        if (String(working['@_item'] ?? '') !== 'normal') continue
        const path = resolve(directory, entry['@_path'])
        if (PathCompare.comparable(path) !== PathCompare.comparable(directory)) paths.push(path)
      }
    }
    return paths
  }

  private static checkLimit(count: number): void {
    if (count > FileChangesLimits.listingEntriesMax)
      throw new Error(`The commit list exceeds ${FileChangesLimits.listingEntriesMax} entries; open a smaller directory`)
  }
}
