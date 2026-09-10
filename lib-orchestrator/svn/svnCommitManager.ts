import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { XMLParser } from 'fast-xml-parser'

import type { FileChangeNodeKind, FileChangeStatus } from '../fileChangesManager/fileChangesManagerApi.types'
import type { GitCommandRunner } from '../git/git.types'
import type { GitCheckpointStore } from '../git/gitCheckpointStore'
import type { CommandOutcome, CommandRunner } from '../shared/commandInvoker.types'
import { ErrorText } from '../shared/errorText'
import { JsonShape } from '../shared/jsonShape'
import { PathCompare } from '../shared/pathCompare'
import type { SvnResult } from './svn.types'

export interface SvnCommitTarget {
  absolutePath: string
  nodeKind: FileChangeNodeKind
  status: FileChangeStatus
}

export interface SvnCommitManagerDeps {
  svn: CommandRunner
  git: GitCommandRunner
  checkpointStore: Pick<GitCheckpointStore, 'existingContextOf'>
}

export class SvnCommitManager {
  constructor(private readonly deps: SvnCommitManagerDeps) {}

  async commit(scope: string, targets: readonly SvnCommitTarget[], messageFile: string): Promise<SvnResult<{ revision: string; output: string }>> {
    if (targets.length === 0 || targets.some((target) => !SvnCommitManager.inside(scope, target.absolutePath)))
      return { ok: false, code: 'svn-failed', detail: 'Select targets inside the commit scope' }
    if (targets.some((target) => target.status === 'conflicted' || target.status === 'obstructed'))
      return { ok: false, code: 'svn-failed', detail: 'Resolve conflicted or obstructed targets before committing' }
    const listed = new Set<string>()
    let temporary: string | null = null
    try {
      for (const target of targets) {
        if (listed.has(target.absolutePath)) continue
        if (target.status === 'untracked') {
          if (target.nodeKind === 'directory') {
            const added = await this.addDirectory(scope, target.absolutePath)
            if (!added.ok) return added
            for (const path of added.value) listed.add(path)
          }
          else if (target.nodeKind === 'file') {
            const added = await this.run(scope, ['add', '--parents', '--non-interactive', '--', `${target.absolutePath}@`])
            if (!added.ok) return added
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
      }
      temporary = await mkdtemp(join(tmpdir(), 'jamat-v3-svn-commit-'))
      const listFile = join(temporary, 'targets.txt')
      await writeFile(listFile, [...listed].map((path) => `${path}@`).join('\n') + '\n', 'utf8')
      const committed = await this.run(scope, [
        'commit', '--non-interactive', '--encoding', 'UTF-8', '--file', messageFile,
        '--targets', listFile, '--depth', 'empty',
      ])
      if (!committed.ok) return committed
      const revision = /Committed revision (\d+)\./.exec(committed.value.stdout)?.[1]
      if (revision === undefined)
        return { ok: false, code: 'svn-failed', detail: committed.value.stdout || 'SVN did not report a committed revision' }
      return { ok: true, value: { revision, output: committed.value.stdout + committed.value.stderr } }
    }
    catch (error) { return { ok: false, code: 'svn-failed', detail: ErrorText.of(error) } }
    finally { if (temporary !== null) await rm(temporary, { recursive: true, force: true }) }
  }

  private async addDirectory(scope: string, directory: string): Promise<SvnResult<readonly string[]>> {
    const own = await this.deps.git.run(directory, ['rev-parse', '--show-toplevel'])
    let commandArgs: readonly string[] | null
    if (own.code === 0 && own.failure === null) commandArgs = []
    else {
      const stored = await this.deps.checkpointStore.existingContextOf(directory)
      if (!stored.ok) return { ok: false, code: 'svn-failed', detail: stored.detail }
      commandArgs = stored.value?.gitDirArgs ?? null
    }
    if (commandArgs === null) {
      const added = await this.run(scope, ['add', '--parents', '--non-interactive', '--', `${directory}@`])
      if (!added.ok) return added
      // Depth-empty commit needs every node recursive add scheduled, including directories.
      const info = await this.run(scope, ['info', '--xml', '--depth', 'infinity', '--non-interactive', '--', `${directory}@`])
      if (!info.ok) return info
      const parsed = new XMLParser({ ignoreAttributes: false }).parse(info.value.stdout) as unknown
      const document = JsonShape.record(JsonShape.record(parsed)?.info)
      const raw = document?.entry
      const entries = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw]
      const paths = entries.map((entry) => resolve(scope, String(JsonShape.record(entry)?.['@_path'] ?? '')))
      if (paths.length === 0 || paths.some((path) => !SvnCommitManager.inside(directory, path)))
        return { ok: false, code: 'svn-failed', detail: 'SVN returned an invalid added subtree' }
      return { ok: true, value: paths }
    }
    const files = await this.deps.git.run(directory, [
      ...commandArgs, 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.',
    ])
    if (files.failure !== null || files.code !== 0)
      return { ok: false, code: 'svn-failed', detail: files.stderr || 'Git could not enumerate the new directory' }
    const paths = [...new Set(files.stdout.split('\0').filter(Boolean).map((path) => resolve(directory, path)))]
    if (paths.some((path) => !SvnCommitManager.inside(directory, path)))
      return { ok: false, code: 'svn-failed', detail: 'Git returned a path outside the new directory' }
    const added = await this.run(scope, ['add', '--parents', '--depth', 'empty', '--non-interactive', '--', `${directory}@`])
    if (!added.ok) return added
    const listed = new Set([directory])
    for (const path of paths) {
      const result = await this.run(scope, ['add', '--parents', '--depth', 'empty', '--non-interactive', '--', `${path}@`])
      if (!result.ok) return result
      listed.add(path)
      let parent = dirname(path)
      while (PathCompare.isInside(directory, parent)) {
        listed.add(parent)
        if (PathCompare.comparable(parent) === PathCompare.comparable(directory)) break
        parent = dirname(parent)
      }
    }
    return { ok: true, value: [...listed] }
  }

  private async run(scope: string, args: string[]): Promise<SvnResult<CommandOutcome>> {
    const outcome = await this.deps.svn.run(scope, args)
    if (outcome.failure === null && outcome.code === 0) return { ok: true, value: outcome }
    const detail = outcome.stderr.trim() || outcome.stdout.trim() || `svn could not run (${outcome.failure ?? outcome.code})`
    const code = outcome.failure === 'command-missing' ? 'svn-missing'
      : /E155011|E160028|out.of.date/i.test(detail) ? 'out-of-date'
      : /E155004|locked/i.test(detail) ? 'locked'
      : /E155007|not a working copy/i.test(detail) ? 'not-a-working-copy'
      : 'svn-failed'
    return { ok: false, code, detail }
  }

  private static inside(scope: string, path: string): boolean {
    return !/[\0\r\n]/.test(path) && PathCompare.isInside(scope, path)
  }
}
