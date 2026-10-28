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
    const untracked = targets.filter((target) => target.status === 'untracked')
      .map((target) => relative(scope, target.absolutePath).replace(/\\/g, '/'))
    const markers: string[] = []
    for (const target of targets) {
      if (target.nodeKind !== 'file' || !['modified', 'added', 'replaced', 'untracked', 'renamed', 'copied'].includes(target.status)) continue
      const content = await readFile(target.absolutePath)
      if (!content.subarray(0, 8192).includes(0) && SvnCommitGate.hasMarkerTriplet(content.toString('utf8')))
        markers.push(relative(scope, target.absolutePath).replace(/\\/g, '/'))
    }
    return { ok: true, value: SvnCommitGate.problems({ conflicted, untracked, markers }) }
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

  async update(scope: string, paths?: readonly string[]): Promise<SvnResult<{ output: string }>> {
    return this.within(scope, paths ?? [], () => this.updateCurrent(scope, paths))
  }

  private async updateCurrent(scope: string, paths?: readonly string[]): Promise<SvnResult<{ output: string }>> {
    if (paths !== undefined && (paths.length === 0 || paths.some((path) => !SvnCommitManager.inside(scope, path))))
      return { ok: false, code: 'svn-failed', detail: 'Select update targets inside the commit scope' }
    const updateTargets = (paths ?? [scope]).map((path) => `${path}@`)
    const depth = paths === undefined ? [] : ['--depth', 'empty']
    let output = ''
    try {
      const updated = await this.run(scope, ['update', '--non-interactive', '--accept', 'postpone', '--ignore-externals', ...depth, '--', ...updateTargets])
      if (!updated.ok) return updated
      output = updated.value.stdout + updated.value.stderr
      const status = await this.run(scope, ['status', '--xml', '--non-interactive', '--ignore-externals', ...depth, '--', ...updateTargets])
      if (!status.ok) return { ...status, detail: `${output}\nCould not check update conflicts: ${status.detail}` }
      const parsed = JsonShape.record(new XMLParser({ ignoreAttributes: false,
        isArray: (name) => name === 'entry' || name === 'target' || name === 'changelist' }).parse(status.value.stdout))
      const statusRoot = JsonShape.record(parsed?.status)
      const targets = statusRoot?.target
      if (!Array.isArray(targets)) return { ok: false, code: 'svn-failed', detail: `${output}\nSVN returned an invalid conflict status` }
      const changelists = statusRoot?.changelist ?? []
      if (!Array.isArray(changelists)) throw new Error('SVN returned invalid changelist status')
      const conflicts: string[] = []
      for (const target of [...targets, ...changelists]) {
        const entries = JsonShape.record(target)?.entry ?? []
        if (!Array.isArray(entries)) throw new Error('SVN returned invalid status entries')
        for (const value of entries) {
          const entry = JsonShape.record(value)
          const working = JsonShape.record(entry?.['wc-status'])
          if (working === null || typeof entry?.['@_path'] !== 'string') throw new Error('SVN returned an invalid status entry')
          if (working['@_item'] === 'conflicted' || working['@_props'] === 'conflicted' || working['@_tree-conflicted'] === 'true')
            conflicts.push(entry['@_path'])
        }
      }
      return conflicts.length === 0 ? { ok: true, value: { output } }
        : { ok: false, code: 'svn-failed', detail: `SVN update left unresolved conflicts:\n${conflicts.join('\n')}\n\n${output}` }
    } catch (error) { return { ok: false, code: 'svn-failed', detail: `${output}\n${ErrorText.of(error)}`.trim() } }
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
