import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { XMLParser } from 'fast-xml-parser'

import type { FileChangeNodeKind, FileChangeStatus } from '../fileChangesManager/fileChangesManagerApi.types'
import type { CommandOutcome, CommandRunner, CommandRunOptions } from '../shared/commandInvoker.types'
import type { CommitProgress } from '../shared/commitProgress.types'
import { ErrorText } from '../shared/errorText'
import { JsonShape } from '../shared/jsonShape'
import { PathCompare } from '../shared/pathCompare'
import type { SvnResult } from './svn.types'
import { SvnCommitProgress } from './commit/svnCommitProgress'

export interface SvnCommitTarget {
  absolutePath: string
  nodeKind: FileChangeNodeKind
  status: FileChangeStatus
}

export class SvnCommitManager {
  constructor(private readonly svn: CommandRunner) {}

  async commit(scope: string, targets: readonly SvnCommitTarget[], messageFile: string,
    onProgress?: (progress: CommitProgress) => void): Promise<SvnResult<{ revision: string; output: string }>> {
    if (targets.length === 0 || targets.some((target) => !SvnCommitManager.inside(scope, target.absolutePath)))
      return { ok: false, code: 'svn-failed', detail: 'Select targets inside the commit scope' }
    if (targets.some((target) => target.status === 'conflicted' || target.status === 'obstructed'))
      return { ok: false, code: 'svn-failed', detail: 'Resolve conflicted or obstructed targets before committing' }
    const listed = new Set<string>()
    const schedules = new Map<string, string | null>()
    let prepared = 0
    let temporary: string | null = null
    try {
      onProgress?.({ stage: 'preparing', completed: 0, total: targets.length })
      for (const target of [...targets].sort((left, right) => left.absolutePath.length - right.absolutePath.length)) {
        if (listed.has(target.absolutePath)) continue
        if (target.status === 'untracked') {
          if (target.nodeKind === 'directory' || target.nodeKind === 'file') {
            const parents = await this.parentsOf(scope, target.absolutePath, schedules)
            if (!parents.ok) return parents
            const added = await this.run(scope, ['add', '--parents', '--depth', 'empty', '--non-interactive', '--', `${target.absolutePath}@`])
            // An attempt that fails after this sweep leaves the path versioned while the shown list
            // still calls it untracked, so the next click sends `untracked` for a path `svn add` now
            // refuses (W150002/E200009) - and every further one does, until somebody reloads. The
            // state the add wanted already holds, so the sweep continues.
            if (!added.ok && !await this.versioned(scope, target.absolutePath)) return added
            for (const parent of parents.value) listed.add(parent)
            listed.add(target.absolutePath)
          }
          else throw new Error(`Unknown node kind: ${JSON.stringify(target.nodeKind)}`)
        }
        else if (target.status === 'missing') {
          const deleted = await this.run(scope, ['delete', '--non-interactive', '--', `${target.absolutePath}@`])
          if (!deleted.ok) return deleted
          listed.add(target.absolutePath)
        }
        else if (target.status === 'added' || target.status === 'modified' || target.status === 'deleted'
          || target.status === 'replaced' || target.status === 'renamed' || target.status === 'copied')
          listed.add(target.absolutePath)
        else if (target.status === 'conflicted' || target.status === 'obstructed')
          throw new Error('A refused target reached staging')
        else throw new Error(`Unknown SVN target status: ${JSON.stringify(target.status)}`)
        prepared += 1
        onProgress?.({ stage: 'preparing', completed: prepared, total: targets.length })
      }
      temporary = await mkdtemp(join(tmpdir(), 'jamat-v3-svn-commit-'))
      const listFile = join(temporary, 'targets.txt')
      await writeFile(listFile, [...listed].map((path) => `${path}@`).join('\n') + '\n', 'utf8')
      const progress = new SvnCommitProgress(listed.size, (value) => onProgress?.(value))
      onProgress?.({ stage: 'sending', completed: 0, total: listed.size })
      const committed = await this.run(scope, [
        'commit', '--non-interactive', '--encoding', 'UTF-8', '--file', messageFile,
        '--targets', listFile, '--depth', 'empty',
      ], { onStdout: (chunk) => progress.accept(chunk) })
      if (!committed.ok) return committed
      const revision = /Committed revision (\d+)\./.exec(committed.value.stdout)?.[1]
      if (revision === undefined)
        return { ok: false, code: 'svn-failed', detail: committed.value.stdout || 'SVN did not report a committed revision' }
      return { ok: true, value: { revision, output: committed.value.stdout + committed.value.stderr } }
    }
    catch (error) { return { ok: false, code: 'svn-failed', detail: ErrorText.of(error) } }
    finally { if (temporary !== null) await rm(temporary, { recursive: true, force: true }) }
  }

  async revertFile(scope: string, path: string): Promise<SvnResult<void>> {
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
      const key = PathCompare.comparable(parent)
      let schedule = schedules.get(key)
      if (schedule === undefined) {
        schedule = await this.scheduleOf(scope, parent)
        schedules.set(key, schedule)
      }
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
    const detail = [outcome.stdout.trim(), outcome.stderr.trim()].filter(Boolean).join('\n') || `svn could not run (${outcome.failure ?? outcome.code})`
    const code = outcome.failure === 'command-missing' ? 'svn-missing'
      : /E155011|E160028|E170004|out.of.date/i.test(detail) ? 'out-of-date'
      : /E155004|locked/i.test(detail) ? 'locked'
      : /E155007|not a working copy/i.test(detail) ? 'not-a-working-copy'
      : 'svn-failed'
    return { ok: false, code, detail }
  }

  private static inside(scope: string, path: string): boolean {
    return !/[\0\r\n]/.test(path) && PathCompare.isInside(scope, path)
  }
}
