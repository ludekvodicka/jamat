import { describe, expect, it } from 'vitest'

import type {
  FileChangesVcs,
  FileChangesVcsBaselineRef,
  FileChangesVcsContentResult,
  FileChangesVcsHistoryGroup,
} from './vcs/fileChangesVcs.types'
import { VcsStatusView } from './vcsStatusView'
import type {
  FileChangesVcsDetection,
  FileChangesVcsResult,
} from './fileChangesManagerApi.types'

describe('lib-orchestrator/fileChangesManager/vcsStatusView', () => {
  class Adapter implements FileChangesVcs {
    readonly probes: string[] = []
    readonly defaultBaselineRef: FileChangesVcsBaselineRef = { kind: 'git-head', revision: 'HEAD' }

    historyBaselineRef(revision: string): FileChangesVcsBaselineRef {
      return { kind: 'git-commit', revision }
    }

    constructor(
      readonly id: 'git' | 'svn',
      private readonly present: boolean,
      private readonly answer: FileChangesVcsResult<boolean> = { ok: true, value: false },
    ) {}

    async detect(cwd: string): Promise<FileChangesVcsDetection | null> {
      if (!this.present) return null
      return {
        id: this.id,
        root: cwd,
        cwd,
        scopeRelativePath: '.',
        scopeUrl: null,
        repositoryPathPrefix: null,
      }
    }

    async dirty(detection: FileChangesVcsDetection): Promise<FileChangesVcsResult<boolean>> {
      this.probes.push(detection.cwd)
      return this.answer
    }

    async status(): Promise<Awaited<ReturnType<FileChangesVcs['status']>>> {
      return { ok: true, value: { entries: [], externalRoots: [] } }
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

  it('detects the preferred VCS when both govern the directory', async () => {
    const git = new Adapter('git', true)
    const svn = new Adapter('svn', true)
    const view = new VcsStatusView([git, svn])

    expect((await view.detect('/work', 'svn'))?.id).toBe('svn')
    expect((await view.detect('/work', 'git'))?.id).toBe('git')
  })

  it('falls back to whichever VCS is present, and answers null when none is', async () => {
    const view = new VcsStatusView([new Adapter('git', false), new Adapter('svn', true)])
    expect((await view.detect('/work', 'git'))?.id).toBe('svn')

    const bare = new VcsStatusView([new Adapter('git', false), new Adapter('svn', false)])
    expect(await bare.detect('/work', 'git')).toBeNull()
  })

  it('routes the probe to the adapter the detection names', async () => {
    const git = new Adapter('git', true, { ok: true, value: true })
    const svn = new Adapter('svn', true)
    const view = new VcsStatusView([git, svn])

    const detection = await view.detect('/work', 'git')
    expect(await view.dirty(detection!)).toEqual({ ok: true, value: true })
    expect(git.probes).toEqual(['/work'])
    expect(svn.probes).toEqual([])
  })

  it('hands a failed probe back rather than turning it into clean', async () => {
    const git = new Adapter('git', true, { ok: false, detail: 'git could not run' })
    const view = new VcsStatusView([git])

    expect(await view.dirty((await view.detect('/work', 'git'))!))
      .toEqual({ ok: false, detail: 'git could not run' })
  })

  it('throws on a detection naming a VCS it has no adapter for', async () => {
    const view = new VcsStatusView([new Adapter('git', true)])
    const foreign: FileChangesVcsDetection = {
      id: 'svn',
      root: '/work',
      cwd: '/work',
      scopeRelativePath: '.',
      scopeUrl: null,
      repositoryPathPrefix: null,
    }

    await expect(view.dirty(foreign)).rejects.toThrow('Unknown VCS id')
  })
})
