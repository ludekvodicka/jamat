import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { FileDiffComputer } from './diff/fileDiffComputer'
import type { FileChangesVcs } from './vcs/fileChangesVcs.types'
import { FileChangesManager } from './fileChangesManager'
import { FileChangesWorkingTreeSources } from './working/fileChangesWorkingTreeSources'

describe('lib-orchestrator/fileChangesManager/fileChangesManager', () => {
  const created: string[] = []

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  function cwd(): string {
    const directory = mkdtempSync(join(tmpdir(), 'jamat-file-changes-manager-'))
    created.push(directory)
    writeFileSync(join(directory, 'file.ts'), 'new\n', 'utf8')
    return directory
  }

  function vcs(root: string): FileChangesVcs {
    return {
      id: 'git',
      defaultBaselineRef: { kind: 'git-head', revision: 'HEAD' },
      historyBaselineRef: (revision: string) => ({ kind: 'git-commit' as const, revision }),
      async detect(directory) {
        return {
          id: 'git',
          root,
          cwd: directory,
          scopeRelativePath: '.',
          scopeUrl: null,
          repositoryPathPrefix: null,
        }
      },
      async status() {
        return { ok: true, value: { externalRoots: [], entries: [{
          absolutePath: join(root, 'file.ts'),
          repositoryPath: 'file.ts',
          nodeKind: 'file',
          status: 'modified',
          previousAbsolutePath: null,
          previousRepositoryPath: null,
          gitState: { index: ' ', worktree: 'M' },
        }] } }
      },
      async dirty() {
        return { ok: true, value: true }
      },
      async history() {
        return { ok: true, value: [{
          id: 'commit',
          revision: 'commit',
          label: 'commit',
          author: 'Ada',
          message: 'Change file',
          createdAt: 2,
          // Deliberately out of order: what a group hands back is ordered by the library, the way
          // the current list is, so the renderer picks a sort key rather than keeping its own copy
          // of the rule.
          entries: ['file.ts', 'a.ts', 'zeta.ts'].map((name) => ({
            absolutePath: join(root, name),
            repositoryPath: name,
            nodeKind: 'file' as const,
            status: 'modified' as const,
            previousAbsolutePath: null,
            previousRepositoryPath: null,
            gitState: null,
          })),
        }] }
      },
      async readBaseline() { return { kind: 'content', content: 'old\n' } },
    }
  }

  function manager(root: string): FileChangesManager {
    return new FileChangesManager({
      diffExecutor: new FileDiffComputer(),
      vcsAdapters: [vcs(root)],
      transcriptResolver: { async resolve() { return null } },
      logReaders: [{ agentId: 'codex', async load() { return [] } }],
    })
  }

  it('reads main-only VCS baselines, distinguishes additions and binary content, and rejects expired tokens', async () => {
    const root = cwd()
    const adapter = vcs(root)
    const instance = new FileChangesManager({ diffExecutor: new FileDiffComputer(), vcsAdapters: [adapter] })
    const listed = await instance.list({ sessionId: 'session', cwd: root, agent: null })
    if (!listed.ok) throw new Error(listed.detail)
    const request = { snapshotId: listed.value.snapshotId, fileId: listed.value.entries[0]!.fileId, baselineId: listed.value.defaultBaseline!.baselineId }
    expect(await instance.readBaseline(request)).toEqual(expect.objectContaining({ ok: true, kind: 'content', content: 'old\n' }))
    adapter.readBaseline = async () => ({ kind: 'missing', detail: 'Added file' })
    expect(await instance.readBaseline(request)).toEqual(expect.objectContaining({ ok: true, kind: 'missing' }))
    adapter.readBaseline = async () => ({ kind: 'content', content: 'binary\0' })
    expect(await instance.readBaseline(request)).toEqual(expect.objectContaining({ ok: true, kind: 'binary' }))
    adapter.readBaseline = async () => ({ kind: 'content', content: 'text' })
    writeFileSync(join(root, 'file.ts'), Buffer.from([255, 0]))
    expect(await instance.readBaseline(request)).toEqual(expect.objectContaining({ ok: true, kind: 'binary' }))
    expect(await instance.readBaseline({ ...request, snapshotId: 'expired' })).toEqual(expect.objectContaining({ ok: false, code: 'snapshot-expired' }))
  })

  it('returns current entries, commit and default baseline tokens and builds their text diff', async () => {
    const root = cwd()
    const listed = await manager(root).list({
      sessionId: 'session',
      cwd: root,
      agent: { agentId: 'codex', nativeSessionId: 'native' },
    })
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    expect(listed.value.vcs).toEqual(expect.objectContaining({ selected: 'git', available: ['git'] }))
    expect(listed.value.entries).toEqual([expect.objectContaining({
      displayPath: 'file.ts',
      status: 'modified',
    })])
    expect(listed.value.history.groups).toEqual([expect.objectContaining({
      baseline: expect.objectContaining({ kind: 'git-commit' }),
    })])
    expect(listed.value.history.groups[0]?.entries.map((entry) => entry.displayPath))
      .toEqual(['a.ts', 'file.ts', 'zeta.ts'])
    const result = await manager(root).diff({
      snapshotId: listed.value.snapshotId,
      fileId: listed.value.entries[0].fileId,
      baselineId: listed.value.defaultBaseline!.baselineId,
    })
    expect(result).toEqual(expect.objectContaining({ ok: false, code: 'snapshot-expired' }))
  })

  it('builds a diff through the same manager instance and rejects unrelated tokens', async () => {
    const root = cwd()
    const managerInstance = manager(root)
    const listed = await managerInstance.list({
      sessionId: 'session',
      cwd: root,
      agent: { agentId: 'codex', nativeSessionId: 'native' },
    })
    if (!listed.ok) throw new Error(listed.detail)
    expect(managerInstance.fileAccess(
      listed.value.snapshotId,
      listed.value.entries[0].fileId,
    )).toEqual({
      ok: true,
      value: expect.objectContaining({
        sessionId: 'session',
        cwd: root,
        path: join(root, 'file.ts'),
        nodeKind: 'file',
        status: 'modified',
      }),
    })
    const result = await managerInstance.diff({
      snapshotId: listed.value.snapshotId,
      fileId: listed.value.entries[0].fileId,
      baselineId: listed.value.defaultBaseline!.baselineId,
    })
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      kind: 'text',
      data: expect.objectContaining({
        hunks: [expect.objectContaining({
          lines: expect.arrayContaining([
            expect.objectContaining({ kind: 'remove', text: 'old' }),
            expect.objectContaining({ kind: 'add', text: 'new' }),
          ]),
        })],
      }),
    }))
    expect(await managerInstance.diff({
      snapshotId: listed.value.snapshotId,
      fileId: 'not-issued',
      baselineId: listed.value.defaultBaseline!.baselineId,
    })).toEqual(expect.objectContaining({ ok: false, code: 'unknown-file' }))
  })

  it('stores current-only source entries in the same file-access and diff runtime', async () => {
    const root = cwd()
    const adapter = vcs(root)
    const detected = (await adapter.detect(root))!
    const status = await adapter.status(detected)
    if (!status.ok) throw new Error(status.detail)
    const workingSources = {
      read: async () => ({
        selection: {
          requested: 'checkpoint' as const,
          selected: 'checkpoint' as const,
          available: ['checkpoint' as const, 'svn' as const],
          fallbackReason: null,
        },
        selected: {
          adapter,
          detection: detected,
          baseline: adapter.defaultBaselineRef,
          baselineLabel: 'Checkpoint HEAD',
        },
        entries: status.value.entries,
        externalRoots: status.value.externalRoots,
        warnings: [],
      }),
    } as unknown as FileChangesWorkingTreeSources
    const managerInstance = new FileChangesManager({
      diffExecutor: new FileDiffComputer(),
      vcsAdapters: [adapter],
      transcriptResolver: { async resolve() { throw new Error('workingTree read the transcript') } },
      workingSources,
    })

    const listed = await managerInstance.workingTree({
      sessionId: 'session', cwd: root, agent: null, worktree: null,
    }, 'checkpoint')

    if (!listed.ok) throw new Error(listed.detail)
    expect(listed.value.source).toEqual(expect.objectContaining({
      selected: 'checkpoint',
      available: ['checkpoint', 'svn'],
    }))
    expect(listed.value.defaultBaseline).toEqual(expect.objectContaining({
      kind: 'git-head',
      label: 'Checkpoint HEAD',
    }))
    expect(managerInstance.fileAccess(
      listed.value.snapshotId,
      listed.value.entries[0].fileId,
    )).toEqual({ ok: true, value: expect.objectContaining({ path: join(root, 'file.ts') }) })
    expect(await managerInstance.diff({
      snapshotId: listed.value.snapshotId,
      fileId: listed.value.entries[0].fileId,
      baselineId: listed.value.defaultBaseline!.baselineId,
    })).toEqual(expect.objectContaining({ ok: true, kind: 'text' }))
  })

  it('groups external file ids in the working snapshot', async () => {
    const root = cwd()
    const adapter = vcs(root)
    const originalStatus = adapter.status.bind(adapter)
    adapter.status = async (detection) => {
      const status = await originalStatus(detection)
      if (!status.ok) throw new Error(status.detail)
      return { ok: true, value: { ...status.value, externalRoots: [root] } }
    }
    const managerInstance = new FileChangesManager({
      diffExecutor: new FileDiffComputer(),
      workingSources: new FileChangesWorkingTreeSources({
        svn: adapter,
        checkpointStore: { existingContextOf: async () => ({ ok: true, value: null }), worktreeBelongsToStore: async () => false },
      }),
    })
    const result = await managerInstance.workingTree({ sessionId: 'session', cwd: root, agent: null, worktree: null }, 'svn')
    if (!result.ok) throw new Error(result.detail)
    expect(result.value.externalRoots).toEqual([{ path: root, displayPath: '', fileIds: result.value.entries.map((entry) => entry.fileId) }])
  })

  it('omits synthetic directories only for commit reads and retains real property changes', async () => {
    const root = cwd()
    const adapter = vcs(root)
    const detected = (await adapter.detect(root))!
    const status = await adapter.status(detected)
    if (!status.ok) throw new Error(status.detail)
    const file = { ...status.value.entries[0], absolutePath: join(root, 'src', 'file.ts'), repositoryPath: 'src/file.ts' }
    const property = { ...file, absolutePath: join(root, 'property'), repositoryPath: 'property', nodeKind: 'directory' as const }
    const managerInstance = new FileChangesManager({
      diffExecutor: new FileDiffComputer(),
      workingSources: { read: async () => ({
        selection: { requested: 'git', selected: 'git', available: ['git'], fallbackReason: null },
        selected: { adapter, detection: detected, baseline: adapter.defaultBaselineRef, baselineLabel: 'HEAD' },
        entries: [file, property], externalRoots: [], warnings: [],
      }) } as unknown as FileChangesWorkingTreeSources,
    })
    const context = { sessionId: 'session', cwd: root, agent: null, worktree: null }
    const normal = await managerInstance.workingTree(context, 'git')
    const commit = await managerInstance.workingTree(context, 'git', true)
    if (!normal.ok || !commit.ok) throw new Error('Listing failed')
    expect(normal.value.entries.map((entry) => entry.displayPath).sort()).toEqual(['property', 'src', 'src/file.ts'])
    expect(commit.value.entries.map((entry) => entry.displayPath).sort()).toEqual(['property', 'src/file.ts'])
  })

  it('builds untracked and deleted VCS files through the direct diff paths', async () => {
    const root = cwd()
    const addedPath = join(root, 'added.txt')
    const deletedPath = join(root, 'deleted.txt')
    writeFileSync(addedPath, 'added one\nadded two\n', 'utf8')
    const adapter = vcs(root)
    adapter.status = async () => ({
      ok: true,
      value: { externalRoots: [], entries: [
        {
          absolutePath: addedPath,
          repositoryPath: 'added.txt',
          nodeKind: 'file',
          status: 'untracked',
          previousAbsolutePath: null,
          previousRepositoryPath: null,
          gitState: { index: '?', worktree: '?' },
        },
        {
          absolutePath: deletedPath,
          repositoryPath: 'deleted.txt',
          nodeKind: 'file',
          status: 'deleted',
          previousAbsolutePath: null,
          previousRepositoryPath: null,
          gitState: { index: ' ', worktree: 'D' },
        },
      ] },
    })
    adapter.readBaseline = async (_detection, repositoryPath) => repositoryPath === 'added.txt'
      ? { kind: 'missing', detail: 'not in HEAD' }
      : { kind: 'content', content: 'deleted one\ndeleted two\n' }
    const managerInstance = new FileChangesManager({
      diffExecutor: {
        async execute() { throw new Error('A one-sided file called the general diff executor') },
      },
      vcsAdapters: [adapter],
      transcriptResolver: { async resolve() { return null } },
      logReaders: [{ agentId: 'codex', async load() { return [] } }],
    })
    const listed = await managerInstance.list({
      sessionId: 'session', cwd: root, agent: null,
    })
    if (!listed.ok || listed.value.defaultBaseline === null)
      throw new Error('The one-sided test has no VCS snapshot')
    const added = listed.value.entries.find((entry) => entry.displayPath === 'added.txt')
    const deleted = listed.value.entries.find((entry) => entry.displayPath === 'deleted.txt')
    if (!added || !deleted) throw new Error('The one-sided files are absent from the snapshot')

    const addedDiff = await managerInstance.diff({
      snapshotId: listed.value.snapshotId,
      fileId: added.fileId,
      baselineId: listed.value.defaultBaseline.baselineId,
    })
    const deletedDiff = await managerInstance.diff({
      snapshotId: listed.value.snapshotId,
      fileId: deleted.fileId,
      baselineId: listed.value.defaultBaseline.baselineId,
    })

    expect(addedDiff).toEqual(expect.objectContaining({
      ok: true,
      kind: 'text',
      data: expect.objectContaining({
        hunks: [expect.objectContaining({ beforeLines: 0, afterLines: 2 })],
      }),
    }))
    expect(deletedDiff).toEqual(expect.objectContaining({
      ok: true,
      kind: 'text',
      data: expect.objectContaining({
        hunks: [expect.objectContaining({ beforeLines: 2, afterLines: 0 })],
      }),
    }))
  })
})
