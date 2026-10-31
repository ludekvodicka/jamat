import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'

import { XMLParser } from 'fast-xml-parser'

import type { FileChangeNodeKind, FileChangeStatus } from '../fileChangesManager/fileChangesManagerApi.types'
import type { CommandOutcome, CommandRunner, CommandRunOptions } from '../shared/commandInvoker.types'
import type { CommitProgress } from '../shared/commitProgress.types'
import { ErrorText } from '../shared/errorText'
import { JsonShape } from '../shared/jsonShape'
import { PathCompare } from '../shared/pathCompare'
import type { SvnResult } from './svn.types'
import { SvnCommitProgress } from './commit/svnCommitProgress'
import { SvnFailures } from './svnFailures'
import { SvnCommitGate } from './svnCommitGate'
import { SvnWorktreeEvidence } from './svnWorktreeEvidence'

export interface SvnCommitTarget {
  absolutePath: string
  nodeKind: FileChangeNodeKind
  status: FileChangeStatus
}

/** One row of `svn status --xml`, with the move's other side and whether the repository changed it (`--show-updates`). */
interface SvnCommitStatusEntry {
  path: string
  item: string
  props: string
  conflicted: boolean
  movedFrom: string | null
  movedTo: string | null
  incoming: boolean
}

export class SvnCommitManager {
  private readonly svn: CommandRunner
  /** `paths` are what the write touches, so a scope that holds several projects can lease each of them. */
  private readonly within: <T>(root: string, paths: readonly string[], work: () => Promise<T>) => Promise<T>

  constructor(svn: CommandRunner, within: SvnCommitManager['within'] = (_root, _paths, work) => work()) { this.svn = svn; this.within = within }

  async commit(scope: string, targets: readonly SvnCommitTarget[], messageFile: string,
    onProgress?: (progress: CommitProgress) => void): Promise<SvnResult<{ revision: string; output: string; committedPaths: readonly string[] }>> {
    return this.within(scope, targets.map((target) => target.absolutePath), () => this.commitCurrent(scope, targets, messageFile, onProgress))
  }

  private async commitCurrent(scope: string, targets: readonly SvnCommitTarget[], messageFile: string,
    onProgress?: (progress: CommitProgress) => void): Promise<SvnResult<{ revision: string; output: string; committedPaths: readonly string[] }>> {
    let temporary: string | null = null
    try {
      const prepared = await this.prepare(scope, targets, onProgress)
      if (!prepared.ok) return prepared
      const listed = new Set(prepared.value.targets)
      temporary = await mkdtemp(join(tmpdir(), 'jamat-v3-svn-commit-'))
      const listFile = join(temporary, 'targets.txt')
      await writeFile(listFile, [...listed].map((path) => `${path}@`).join('\n') + '\n', 'utf8')
      const progress = new SvnCommitProgress(listed.size, (value) => onProgress?.(value))
      onProgress?.({ stage: 'sending', completed: 0, total: listed.size })
      // An added scope has no committed revision; the repository root still provides the bound.
      const bound = await this.run(scope, ['info', '--xml', '-r', 'HEAD', '--non-interactive', '--', '^/@'])
      if (!bound.ok) return bound
      const lower = SvnFailures.infoRevisionOf(bound.value.stdout)
      const committed = await this.run(scope, [
        'commit', '--non-interactive', '--encoding', 'UTF-8', '--file', messageFile,
        '--targets', listFile, '--depth', 'empty',
      ], { onStdout: (chunk) => progress.accept(chunk) })
      if (!committed.ok) return committed
      let revision = SvnFailures.revisionOf(committed.value.stdout)
      if (revision === null) {
        const info = await this.run(scope, ['info', '--xml', '--non-interactive', '--', `${prepared.value.targets[0]}@`])
        if (!info.ok) return info
        revision = SvnFailures.infoRevisionOf(info.value.stdout)
        if (revision === null || lower === null || revision <= lower)
          return { ok: false, code: 'svn-failed', detail: 'SVN did not report a committed revision and first-target info does not prove a revision above the pre-commit bound' }
      }
      // SVN's C-locale notifications have a 15-character prefix. Trimming it would lose
      // leading spaces in literal filenames and could claim an unchanged sibling was sent.
      const sent = committed.value.stdout.split(/\r?\n/).flatMap((line) =>
        /^(Sending {8}|Adding {9}|Adding {2}\(bin\) {2}|Deleting {7}|Replacing {6}).+$/.test(line)
          ? [{ path: resolve(scope, line.slice(15)), deleting: line.startsWith('Deleting ') }] : [])
      // SVN reports a deleted directory as one line, so the selected files under it are sent by it.
      const deletedWith = targets.flatMap(({ absolutePath }) => sent.some(({ path, deleting }) => deleting
        && PathCompare.comparable(path) !== PathCompare.comparable(absolutePath) && PathCompare.isInside(path, absolutePath))
        ? [absolutePath] : [])
      const committedPaths = [...new Set([...sent.map(({ path }) => path), ...deletedWith])]
      return { ok: true, value: { revision: String(revision), output: committed.value.stdout + committed.value.stderr, committedPaths } }
    }
    catch (error) { return { ok: false, code: 'svn-failed', detail: ErrorText.of(error) } }
    finally { if (temporary !== null) await rm(temporary, { recursive: true, force: true }) }
  }

  async prepare(scope: string, targets: readonly SvnCommitTarget[], onProgress?: (progress: CommitProgress) => void, beforeAdd?: (paths: string[]) => Promise<void>): Promise<SvnResult<{ targets: string[]; added: string[] }>> {
    if (targets.length === 0 || targets.some((target) => !SvnCommitManager.inside(scope, target.absolutePath)))
      return { ok: false, code: 'svn-failed', detail: 'Select targets inside the commit scope' }
    if (targets.some((target) => target.status === 'conflicted' || target.status === 'obstructed'))
      return { ok: false, code: 'refused', detail: targets.filter((target) => target.status === 'conflicted' || target.status === 'obstructed')
        .map((target) => `Refused: ${relative(scope, target.absolutePath).replace(/\\/g, '/')} is conflicted or obstructed`).join('\n') }
    // svn.exe reads its arguments and a --targets file in the system ANSI code page, so a name outside
    // ASCII reaches it changed or not at all (svn 1.14.5, code page 1252: `ť` became `t`, E200009).
    const unpassable = targets.map((target) => relative(scope, target.absolutePath).replace(/\\/g, '/')).filter((path) => !SvnWorktreeEvidence.takesArgument(path))
    if (unpassable.length > 0)
      return { ok: false, code: 'refused', detail: `svn cannot take these names from Jamat, they contain characters outside ASCII: ${unpassable.join(', ')}. `
        + 'Commit them with TortoiseSVN, or rename them.' }
    const listed = new Set<string>()
    const newlyAdded = new Set<string>()
    const additions: string[] = []
    const missing: string[] = []
    const schedules = new Map<string, string | null>()
    let prepared = 0
    try {
      const gate = await this.gateOf(scope, targets)
      if (!gate.ok) return gate
      if (gate.value.length > 0) return { ok: false, code: 'refused', detail: gate.value.join('\n') }
      onProgress?.({ stage: 'preparing', completed: 0, total: targets.length })
      const deletionRoots = await this.deletionRootsOf(scope, targets, schedules)
      if (!deletionRoots.ok) return deletionRoots
      for (const target of [...targets].sort((left, right) => left.absolutePath.length - right.absolutePath.length)) {
        if (listed.has(target.absolutePath)) continue
        if (target.status === 'untracked') {
          if (target.nodeKind === 'directory' || target.nodeKind === 'file') {
            const parents = await this.parentsOf(scope, target.absolutePath, schedules)
            if (!parents.ok) return parents
            for (const parent of parents.value) {
              listed.add(parent)
              if (schedules.get(PathCompare.comparable(parent)) === null) newlyAdded.add(parent)
            }
            additions.push(target.absolutePath)
            listed.add(target.absolutePath)
          }
          else throw new Error(`Unknown node kind: ${JSON.stringify(target.nodeKind)}`)
        }
        else if (target.status === 'missing') {
          missing.push(target.absolutePath)
          listed.add(target.absolutePath)
        }
        else if (target.status === 'added' || target.status === 'replaced' || target.status === 'copied') {
          const parents = await this.parentsOf(scope, target.absolutePath, schedules)
          if (!parents.ok) return parents
          for (const parent of parents.value) listed.add(parent)
          listed.add(target.absolutePath)
        }
        else if (target.status === 'modified' || target.status === 'deleted' || target.status === 'renamed')
          listed.add(target.absolutePath)
        else if (target.status === 'conflicted' || target.status === 'obstructed')
          throw new Error('A refused target reached staging')
        else throw new Error(`Unknown SVN target status: ${JSON.stringify(target.status)}`)
        prepared += 1
        onProgress?.({ stage: 'preparing', completed: prepared, total: targets.length })
      }
      if (additions.length > 0) {
        await beforeAdd?.([...new Set([...newlyAdded, ...additions])])
        for (const batch of SvnCommitManager.batches(additions)) {
          const added = await this.run(scope, ['add', '--parents', '--depth', 'empty', '--non-interactive', '--', ...batch.map((path) => `${path}@`)])
          if (!added.ok) {
            // A prior interrupted preparation can have scheduled part of this exact selection.
            for (const path of batch) if (!await this.versioned(scope, path)) return added
          }
          for (const path of batch) newlyAdded.add(path)
        }
      }
      for (const batch of SvnCommitManager.batches(missing)) {
        const deleted = await this.run(scope, ['delete', '--non-interactive', '--', ...batch.map((path) => `${path}@`)])
        if (!deleted.ok) return deleted
      }
      for (const root of deletionRoots.value) listed.add(root)
      return { ok: true, value: { targets: [...listed], added: [...newlyAdded] } }
    }
    catch (error) { return { ok: false, code: 'svn-failed', detail: ErrorText.of(error) } }
  }

  private async gateOf(scope: string, targets: readonly SvnCommitTarget[]): Promise<SvnResult<string[]>> {
    const status = await this.run(scope, ['status', '--xml', '--', '.'])
    if (!status.ok) return status
    const conflicted = SvnWorktreeEvidence.statusRows(status.value.stdout, scope).filter((row) => row.conflict).map((row) => row.path)
    const moves = SvnCommitManager.movePairProblems(scope, SvnCommitManager.statusEntriesOf(scope, status.value.stdout), targets)
    const untracked = targets.filter((target) => target.status === 'untracked')
      .map((target) => relative(scope, target.absolutePath).replace(/\\/g, '/'))
    const markers: string[] = []
    for (const target of targets) {
      if (target.nodeKind !== 'file' || !['modified', 'added', 'replaced', 'untracked', 'renamed', 'copied'].includes(target.status)) continue
      const content = await readFile(target.absolutePath)
      if (!content.subarray(0, 8192).includes(0) && SvnCommitGate.hasMarkerTriplet(content.toString('utf8')))
        markers.push(relative(scope, target.absolutePath).replace(/\\/g, '/'))
    }
    const problems = SvnCommitGate.problems({ conflicted, untracked, markers })
    return { ok: true, value: problems.length > 0 ? problems : moves }
  }

  /**
   * SVN commits a move only with both of its sides and refuses either half alone with E200009. A
   * review whose source rows lost their checks (they were conflicted when the list reloaded) sent the
   * same 93 of 97 paths three times; this names the missing side before anything is staged. A source
   * inside a selected deleted directory travels with that directory.
   */
  private static movePairProblems(scope: string, entries: readonly SvnCommitStatusEntry[], targets: readonly SvnCommitTarget[]): string[] {
    const selected = new Set(targets.map((target) => PathCompare.comparable(target.absolutePath)))
    const removed = targets.filter((target) => target.status === 'deleted' || target.status === 'replaced' || target.status === 'missing')
    const covered = (path: string): boolean => selected.has(PathCompare.comparable(path))
      || removed.some((target) => target.nodeKind === 'directory' && PathCompare.isInside(target.absolutePath, path))
    const shown = (path: string): string => relative(scope, path).replace(/\\/g, '/') || '.'
    const problems = new Map<string, string>()
    for (const entry of entries) {
      if (entry.movedFrom !== null && selected.has(PathCompare.comparable(entry.path)) && !covered(entry.movedFrom))
        problems.set(PathCompare.comparable(entry.movedFrom), `${shown(entry.path)} was moved from ${shown(entry.movedFrom)}, and SVN commits a move only with both sides: select ${shown(entry.movedFrom)} as well, or neither.`)
      if (entry.movedTo !== null && covered(entry.path) && !selected.has(PathCompare.comparable(entry.movedTo)))
        problems.set(PathCompare.comparable(entry.movedTo), `${shown(entry.path)} was moved to ${shown(entry.movedTo)}, and SVN commits a move only with both sides: select ${shown(entry.movedTo)} as well, or neither.`)
    }
    return [...problems.values()]
  }

  async revertFile(scope: string, path: string): Promise<SvnResult<void>> {
    return this.within(scope, [path], () => this.revertCurrent(scope, path))
  }

  private async revertCurrent(scope: string, path: string): Promise<SvnResult<void>> {
    if (!SvnCommitManager.inside(scope, path))
      return { ok: false, code: 'svn-failed', detail: 'Select a file inside the commit scope' }
    const info = await this.run(scope, ['info', '--xml', '--non-interactive', '--', `${path}@`])
    if (!info.ok) return info
    const parsed = JsonShape.record(new XMLParser({ ignoreAttributes: false }).parse(info.value.stdout))
    const entry = JsonShape.record(JsonShape.record(parsed?.info)?.entry)
    const working = JsonShape.record(entry?.['wc-info'])
    if (entry?.['@_kind'] !== 'file' || working === null
      || working['moved-from'] !== undefined || working['moved-to'] !== undefined
      || (working.schedule !== 'normal' && working.schedule !== 'delete'))
      return { ok: false, code: 'svn-failed', detail: 'Revert supports existing versioned files; handle additions, moves and directories in your SVN client' }
    const reverted = await this.run(scope, ['revert', '--depth', 'empty', '--non-interactive', '--', `${path}@`])
    return reverted.ok ? { ok: true, value: undefined } : reverted
  }

  /**
   * The one update a commit SVN refused as out of date gets: the paths SVN named in `failure`, each
   * at depth empty, or nothing at all.
   *
   * The 3.11.1 recovery updated every selected node at depth empty. A moved node updated as its own
   * target raises "local file moved away, incoming file edit upon update" even when nothing came
   * in, and the destinations below a new directory are skipped, so one review with a moved directory
   * turned into four tree conflicts and could not commit again (audit B1). SVN names the node whose
   * BASE is behind: for a deleted directory, a BASE older than the commits of its own files. Bringing
   * that node alone to HEAD is all the retry needs, and it never targets a moved node.
   *
   * A depth-empty update hides what came in below the node, so a directory this commit deletes or
   * moves is updated only when nothing below it changed: otherwise the retry would delete somebody's
   * change unseen, and a deeper update raises the tree conflict a person has to settle. That, a moved
   * node, and a change coming into work this commit does not hold stop with code `refused` before any
   * write, naming what to update by hand.
   */
  async updateOutOfDate(scope: string, failure: string, selected: readonly string[]): Promise<SvnResult<{ output: string }>> {
    try {
      const named = await this.outOfDatePathsOf(scope, failure)
      if (!named.ok) return named
      return await this.within(scope, named.value, () => this.updateOutOfDateCurrent(scope, named.value, selected))
    }
    catch (error) { return { ok: false, code: 'svn-failed', detail: ErrorText.of(error) } }
  }

  private async updateOutOfDateCurrent(scope: string, named: readonly string[], selected: readonly string[]): Promise<SvnResult<{ output: string }>> {
    const chosen = new Set(selected.map(PathCompare.comparable))
    const entries: SvnCommitStatusEntry[] = []
    for (const batch of SvnCommitManager.batches(named)) {
      const status = await this.run(scope, ['status', '--xml', '--show-updates', '--non-interactive', '--ignore-externals', '--', ...batch.map((path) => `${path}@`)])
      if (!status.ok) return { ...status, detail: `Could not read what the update would bring:\n${status.detail}` }
      entries.push(...SvnCommitManager.statusEntriesOf(scope, status.value.stdout))
    }
    const blockers = named.flatMap((path) => SvnCommitManager.updateBlockerOf(scope, path, entries, chosen))
    if (blockers.length > 0)
      return { ok: false, code: 'refused', detail: [...blockers, 'Jamat updated nothing. Update the path named above in your SVN client, settle what it reports, then reload this review and commit again.'].join('\n') }
    let output = ''
    try {
      for (const batch of SvnCommitManager.batches(named)) {
        const updated = await this.run(scope, ['update', '--non-interactive', '--accept', 'postpone', '--ignore-externals', '--depth', 'empty', '--', ...batch.map((path) => `${path}@`)])
        if (!updated.ok) return { ...updated, detail: `${output}${updated.detail}` }
        output += updated.value.stdout + updated.value.stderr
      }
      const conflicts: string[] = []
      for (const batch of SvnCommitManager.batches(named)) {
        const status = await this.run(scope, ['status', '--xml', '--non-interactive', '--ignore-externals', '--depth', 'empty', '--', ...batch.map((path) => `${path}@`)])
        if (!status.ok) return { ...status, detail: `${output}\nCould not check update conflicts: ${status.detail}` }
        conflicts.push(...SvnCommitManager.statusEntriesOf(scope, status.value.stdout).filter((entry) => entry.conflicted).map((entry) => entry.path))
      }
      return conflicts.length === 0 ? { ok: true, value: { output } }
        : { ok: false, code: 'svn-failed', detail: `SVN update left unresolved conflicts:\n${conflicts.join('\n')}\n\n${output}` }
    } catch (error) { return { ok: false, code: 'svn-failed', detail: `${output}\n${ErrorText.of(error)}`.trim() } }
  }

  /**
   * The paths an out-of-date commit failure names. E155011 carries the working-copy path; the server
   * codes carry the repository path, placed through the scope's repository-relative URL. The text
   * around them is localized, the code and the quoted path are not.
   */
  private async outOfDatePathsOf(scope: string, failure: string): Promise<SvnResult<string[]>> {
    const local: string[] = []
    const repository: string[] = []
    for (const line of failure.split(/\r?\n/)) {
      const match = /\b(E155011|E160028|E160024|E160042|E170004): [^']*'(.*)'/.exec(line)
      if (match === null) continue
      else if (match[1] === 'E155011') local.push(resolve(scope, match[2]))
      else repository.push(match[2])
    }
    let paths = local
    if (paths.length === 0 && repository.length > 0) {
      const info = await this.run(scope, ['info', '--xml', '--non-interactive', '--', `${scope}@`])
      if (!info.ok) return info
      const relativeUrl = JsonShape.record(JsonShape.record(JsonShape.record(new XMLParser().parse(info.value.stdout))?.info)?.entry)?.['relative-url']
      if (typeof relativeUrl !== 'string' || !relativeUrl.startsWith('^/')) throw new Error(`SVN info gave no repository-relative URL for ${scope}`)
      const base = decodeURIComponent(relativeUrl.slice(1)).replace(/\/+$/, '')
      const outside = repository.filter((path) => path !== base && !path.startsWith(`${base}/`))
      if (outside.length > 0)
        return { ok: false, code: 'refused', detail: `SVN reports ${outside.join(', ')} out of date, outside this commit's working copy ${scope}. Jamat updated nothing. Update that path in your SVN client, then commit again.` }
      paths = repository.map((path) => resolve(scope, `.${path.slice(base.length)}`))
    }
    const unique = [...new Map(paths.map((path) => [PathCompare.comparable(path), path])).values()]
    if (unique.length === 0)
      return { ok: false, code: 'refused', detail: 'SVN reported this commit out of date without naming the path. Jamat updated nothing. Update the out-of-date directory in your SVN client, then commit again.' }
    const outside = unique.filter((path) => !SvnCommitManager.inside(scope, path))
    if (outside.length > 0)
      return { ok: false, code: 'refused', detail: `SVN reports ${outside.join(', ')} out of date, outside this commit's working copy ${scope}. Jamat updated nothing. Update that path in your SVN client, then commit again.` }
    return { ok: true, value: unique }
  }

  /** Why a depth-empty update of `path` must not run, from `svn status --show-updates` of it; empty when it may. */
  private static updateBlockerOf(scope: string, path: string, entries: readonly SvnCommitStatusEntry[], chosen: ReadonlySet<string>): string[] {
    const key = PathCompare.comparable(path)
    const shown = relative(scope, path).replace(/\\/g, '/') || '.'
    const own = entries.find((entry) => PathCompare.comparable(entry.path) === key)
    const incoming = entries.filter((entry) => entry.incoming && PathCompare.isInside(path, entry.path))
    const listed = incoming.slice(0, 10).map((entry) => relative(scope, entry.path).replace(/\\/g, '/') || '.').join(', ')
      + (incoming.length > 10 ? ` and ${incoming.length - 10} more` : '')
    if (own === undefined) return []
    const counterpart = own.movedTo ?? own.movedFrom
    if (counterpart !== null)
      return [`Update ${shown} together with ${relative(scope, counterpart).replace(/\\/g, '/')} yourself: SVN reports ${shown} out of date, and it is one side of a move, which an update of one side alone turns into a tree conflict.`]
    if (own.conflicted) return [`Settle the conflict on ${shown} first: SVN reports it out of date and it is already conflicted.`]
    const removed = own.item === 'deleted' || own.item === 'replaced' || own.item === 'missing' || own.item === 'obstructed' || own.item === 'incomplete'
    if (removed && incoming.length > 0)
      return [`Update ${shown} yourself: this commit deletes or replaces it, and the repository changed ${listed} since. Committing would drop that change unseen, and updating raises a tree conflict only you can settle (for a moved file, svn resolve --accept mine-conflict takes the change into the moved file).`]
    const changedHere = own.item === 'modified' || own.item === 'merged' || own.props === 'modified'
    if (!removed && own.incoming && changedHere && !chosen.has(key))
      return [`Update ${shown} yourself when its local change allows: SVN reports it out of date, and the update would merge the repository change into work this commit does not hold.`]
    return []
  }

  private static statusEntriesOf(scope: string, xml: string): SvnCommitStatusEntry[] {
    const parsed = JsonShape.record(new XMLParser({ ignoreAttributes: false,
      isArray: (name) => name === 'entry' || name === 'target' || name === 'changelist' }).parse(xml))
    const statusRoot = JsonShape.record(parsed?.status)
    const targets = statusRoot?.target
    if (!Array.isArray(targets)) throw new Error('SVN returned an invalid status')
    const changelists = statusRoot?.changelist ?? []
    if (!Array.isArray(changelists)) throw new Error('SVN returned invalid changelist status')
    const rows: SvnCommitStatusEntry[] = []
    // SVN writes a move's other side relative to the status target the entry was reached through.
    const only = targets.length === 1 ? JsonShape.record(targets[0])?.['@_path'] : undefined
    for (const target of [...targets, ...changelists]) {
      const targetPath = targets.includes(target) ? JsonShape.record(target)?.['@_path'] : only
      const base = typeof targetPath === 'string' ? resolve(scope, targetPath) : scope
      const values = JsonShape.record(target)?.entry ?? []
      if (!Array.isArray(values)) throw new Error('SVN returned invalid status entries')
      for (const value of values) {
        const entry = JsonShape.record(value)
        const working = JsonShape.record(entry?.['wc-status'])
        if (working === null || typeof entry?.['@_path'] !== 'string') throw new Error('SVN returned an invalid status entry')
        const repository = JsonShape.record(entry['repos-status'])
        const item = String(working['@_item'] ?? 'none')
        const props = String(working['@_props'] ?? 'none')
        rows.push({ path: resolve(scope, entry['@_path']), item, props,
          conflicted: item === 'conflicted' || props === 'conflicted' || working['@_tree-conflicted'] === 'true',
          movedFrom: typeof working['@_moved-from'] === 'string' ? resolve(base, working['@_moved-from']) : null,
          movedTo: typeof working['@_moved-to'] === 'string' ? resolve(base, working['@_moved-to']) : null,
          incoming: repository !== null && ((repository['@_item'] ?? 'none') !== 'none' || (repository['@_props'] ?? 'none') !== 'none') })
      }
    }
    return rows
  }

  /**
   * What `svn add --parents` versions on the way to `path`, and whether it may run at all.
   *
   * Every directory it creates has to reach the target list with the path it was created for:
   * `svn commit --depth empty` on a child whose parent add is not in the same commit stops with
   * E200009 and publishes nothing. A parent scheduled for deletion is the dangerous one. There the
   * add does not fail, it REPLACES that directory, so a review prepared with
   * `svn delete --keep-local` publishes the whole subtree again instead of the deletion it shows.
   * The files that stay on disk are exactly what comes back as untracked rows, so that reversal is
   * one confirmed dialog away. This commit therefore stops before the first write.
   */
  private async parentsOf(scope: string, path: string, schedules: Map<string, string | null>): Promise<SvnResult<readonly string[]>> {
    const staged: string[] = []
    let parent = dirname(path)
    while (SvnCommitManager.inside(scope, parent)) {
      const schedule = await this.cachedScheduleOf(scope, parent, schedules)
      if (schedule === 'delete')
        return { ok: false, code: 'svn-failed', detail: `${parent} is scheduled for deletion, so adding ${path} inside it would replace that directory and publish everything under it again. Leave the path out of the commit, or revert the deletion first.` }
      else if (schedule === 'normal') break
      // An unversioned parent is what `--parents` is for; one already scheduled for addition or
      // replacement is unpublished either way, so both have to travel with the child.
      else if (schedule === 'add' || schedule === 'replace' || schedule === null) staged.push(parent)
      else throw new Error(`Unknown SVN schedule: ${JSON.stringify(schedule)}`)
      const next = dirname(parent)
      if (next === parent) break
      parent = next
    }
    return { ok: true, value: staged.reverse() }
  }

  /**
   * The deleted directories the selected deletions are published from.
   *
   * SVN deletes a directory as one node, so a file deleted with its directory reaches the
   * repository only through that directory's target: alone, a move out of it stops with E200009
   * ("both sides of the move must be committed together") and a plain deletion sends nothing. The
   * directory deletes everything under it, so it joins only when the selection already holds every
   * file under it; otherwise this commit stops before the first write.
   */
  private async deletionRootsOf(scope: string, targets: readonly SvnCommitTarget[],
    schedules: Map<string, string | null>): Promise<SvnResult<readonly string[]>> {
    const selected = new Set(targets.map((target) => PathCompare.comparable(target.absolutePath)))
    const roots = new Map<string, string>()
    for (const target of targets) {
      if (target.status !== 'deleted') continue
      let root: string | null = null
      for (let parent = dirname(target.absolutePath); SvnCommitManager.inside(scope, parent); parent = dirname(parent)) {
        if (await this.cachedScheduleOf(scope, parent, schedules) !== 'delete') break
        root = parent
        if (dirname(parent) === parent) break
      }
      if (root === null || selected.has(PathCompare.comparable(root)) || roots.has(PathCompare.comparable(root))) continue
      const info = await this.run(scope, ['info', '--xml', '--depth', 'infinity', '--non-interactive', '--', `${root}@`])
      if (!info.ok) return info
      const entries = JsonShape.record(JsonShape.record(new XMLParser({ ignoreAttributes: false,
        isArray: (name) => name === 'entry' }).parse(info.value.stdout))?.info)?.entry
      if (!Array.isArray(entries)) throw new Error(`SVN returned invalid info for ${root}`)
      const unselected = entries.flatMap((value) => {
        const entry = JsonShape.record(value)
        if (typeof entry?.['@_path'] !== 'string') throw new Error(`SVN returned an info entry without a path under ${root}`)
        const path = resolve(scope, entry['@_path'])
        return entry['@_kind'] === 'file' && !selected.has(PathCompare.comparable(path)) ? [path] : []
      })
      if (unselected.length > 0)
        return { ok: false, code: 'svn-failed', detail: `${target.absolutePath} is deleted together with ${root}, and SVN publishes that deletion only as the whole directory, which also deletes:\n${unselected.join('\n')}\nSelect those files as well, or leave the deletions inside ${root} out of this commit.` }
      roots.set(PathCompare.comparable(root), root)
    }
    return { ok: true, value: [...roots.values()] }
  }

  private async cachedScheduleOf(scope: string, path: string, schedules: Map<string, string | null>): Promise<string | null> {
    const key = PathCompare.comparable(path)
    let schedule = schedules.get(key)
    if (schedule === undefined) {
      schedule = await this.scheduleOf(scope, path)
      schedules.set(key, schedule)
    }
    return schedule
  }

  /**
   * The target itself, never its parent: `svn add --parents` versions the parent of the first
   * sibling it stages, so a parent that answers yes says nothing about this path, and a path left
   * unversioned would go into the target list and fail the commit with a different message.
   */
  private async versioned(scope: string, path: string): Promise<boolean> {
    return await this.scheduleOf(scope, path) !== null
  }

  /** `normal`, `add`, `delete` or `replace` for a versioned path; null when SVN does not know it. */
  private async scheduleOf(scope: string, path: string): Promise<string | null> {
    const info = await this.run(scope, ['info', '--xml', '--non-interactive', '--', `${path}@`])
    if (!info.ok) return null
    const parsed = JsonShape.record(new XMLParser({ ignoreAttributes: false }).parse(info.value.stdout))
    const schedule = JsonShape.record(JsonShape.record(JsonShape.record(parsed?.info)?.entry)?.['wc-info'])?.schedule
    return typeof schedule === 'string' ? schedule : null
  }

  private async run(scope: string, args: string[], options?: CommandRunOptions): Promise<SvnResult<CommandOutcome>> {
    const outcome = await this.svn.run(scope, args, options)
    if (outcome.failure === null && outcome.code === 0) return { ok: true, value: outcome }
    return { ok: false, ...SvnFailures.failureOf(outcome) }
  }

  private static inside(scope: string, path: string): boolean {
    return !/[\0\r\n]/.test(path) && PathCompare.isInside(scope, path)
  }

  /**
   * Bounded argument lists for the subcommands that take several paths. `svn update` and
   * `svn status` accept no `--targets` file, and an update of every selected node in one process
   * exceeded the Windows command line (spawn ENAMETOOLONG, applications/Jamat#77). A `--targets`
   * file is no way out for `add` and `delete` either: svn reads it in the ANSI code page, not UTF-8.
   */
  private static batches(paths: readonly string[]): string[][] {
    const batches: string[][] = []
    let batch: string[] = []
    let size = 0
    for (const path of paths) {
      const length = path.length * 2 + 4
      if (length > 24_000) throw new Error(`SVN target is too long: ${path}`)
      if (size + length > 24_000) { batches.push(batch); batch = []; size = 0 }
      batch.push(path)
      size += length
    }
    if (batch.length > 0) batches.push(batch)
    return batches
  }
}
