import { describe, expect, it } from 'vitest'

import type {
  FileChangesVcs,
  FileChangesVcsBaselineRef,
  FileChangesVcsContentResult,
  FileChangesVcsHistoryGroup,
} from './fileChangesVcs.types'
import { FileChangesVcsDetector } from './fileChangesVcsDetector'
import type {
  FileChangesVcsDetection,
  FileChangesVcsResult,
} from '../fileChangesManagerApi.types'

describe('lib-orchestrator/fileChangesManager/vcs/fileChangesVcsDetector', () => {
  class Adapter implements FileChangesVcs {
    readonly defaultBaselineRef: FileChangesVcsBaselineRef = { kind: 'git-head', revision: 'HEAD' }

    historyBaselineRef(revision: string): FileChangesVcsBaselineRef {
      return { kind: 'git-commit', revision }
    }

    constructor(
      readonly id: 'git' | 'svn',
      private readonly outcome: 'available' | 'missing' | 'failure',
    ) {}

    async detect(cwd: string): Promise<FileChangesVcsDetection | null> {
      if (this.outcome === 'available')
        return {
          id: this.id,
          root: cwd,
          cwd,
          scopeRelativePath: '.',
          scopeUrl: null,
          repositoryPathPrefix: null,
        }
      else if (this.outcome === 'missing') return null
      else if (this.outcome === 'failure') throw new Error(`${this.id} failed`)
      else
        throw new Error(`Unknown adapter outcome: ${JSON.stringify(this.outcome)}`)
    }

    async status(): Promise<Awaited<ReturnType<FileChangesVcs['status']>>> {
      return { ok: true, value: { entries: [], externalRoots: [] } }
    }

    async dirty(): Promise<FileChangesVcsResult<boolean>> {
      return { ok: true, value: false }
    }

    async history(): Promise<FileChangesVcsResult<readonly FileChangesVcsHistoryGroup[]>> {
      return { ok: true, value: [] }
    }

    async readBaseline(
      _detection: FileChangesVcsDetection,
      _repositoryPath: string,
      _baseline: FileChangesVcsBaselineRef,
    ): Promise<FileChangesVcsContentResult> {
      return { kind: 'unavailable', detail: 'unused' }
    }
  }

  it('selects the preferred VCS when both are available', async () => {
    const selected = await new FileChangesVcsDetector([
      new Adapter('git', 'available'),
      new Adapter('svn', 'available'),
    ]).select('Q:/Project', 'svn')

    expect(selected.selected?.adapter.id).toBe('svn')
    expect(selected.available.map((item) => item.adapter.id)).toEqual(['git', 'svn'])
    expect(selected.fallbackReason).toBeNull()
  })

  it('falls back explicitly when the preferred detector fails', async () => {
    const selected = await new FileChangesVcsDetector([
      new Adapter('svn', 'failure'),
      new Adapter('git', 'available'),
    ]).select('Q:/Project', 'svn')

    expect(selected.selected?.adapter.id).toBe('git')
    expect(selected.fallbackReason).toBe('svn is not available in Q:/Project; using git')
  })

  it('returns no selection when no VCS is available', async () => {
    const selected = await new FileChangesVcsDetector([
      new Adapter('git', 'missing'),
      new Adapter('svn', 'missing'),
    ]).select('Q:/Project', 'git')

    expect(selected.selected).toBeNull()
    expect(selected.available).toEqual([])
    expect(selected.fallbackReason).toBeNull()
  })
})
