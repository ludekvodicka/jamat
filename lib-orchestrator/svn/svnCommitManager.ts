import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { XMLParser } from 'fast-xml-parser'

import type { FileChangeNodeKind, FileChangeStatus } from '../fileChangesManager/fileChangesManagerApi.types'
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

export class SvnCommitManager {
  constructor(private readonly svn: CommandRunner) {}

  async commit(scope: string, targets: readonly SvnCommitTarget[], messageFile: string): Promise<SvnResult<{ revision: string; output: string }>> {
    if (targets.length === 0 || targets.some((target) => !SvnCommitManager.inside(scope, target.absolutePath)))
      return { ok: false, code: 'svn-failed', detail: 'Select targets inside the commit scope' }
    if (targets.some((target) => target.status === 'conflicted' || target.status === 'obstructed'))
      return { ok: false, code: 'svn-failed', detail: 'Resolve conflicted or obstructed targets before committing' }
    const listed = new Set<string>()
    let temporary: string | null = null
    try {
      for (const target of [...targets].sort((left, right) => left.absolutePath.length - right.absolutePath.length)) {
        if (listed.has(target.absolutePath)) continue
        if (target.status === 'untracked') {
          if (target.nodeKind === 'directory' || target.nodeKind === 'file') {
            const added = await this.run(scope, ['add', '--parents', '--depth', 'empty', '--non-interactive', '--', `${target.absolutePath}@`])
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

  private async run(scope: string, args: string[]): Promise<SvnResult<CommandOutcome>> {
    const outcome = await this.svn.run(scope, args)
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
