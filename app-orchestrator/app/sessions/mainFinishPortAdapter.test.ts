import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { FileDiffComputer } from '../../../lib-orchestrator/fileChangesManager/diff/fileDiffComputer'
import { FileChangesManager } from '../../../lib-orchestrator/fileChangesManager/fileChangesManager'
import type { FileChangesVcs } from '../../../lib-orchestrator/fileChangesManager/vcs/fileChangesVcs.types'
import { MainFinishPortAdapter } from './mainFinishPortAdapter'

describe('app/sessions/mainFinishPortAdapter', () => {
  const created: string[] = []

  afterEach(() => {
    for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  /** The status lists `own.ts`, `early.ts` and `foreign.ts`; the transcript names only `own.ts`. */
  function adapterOf(claimsOf: (root: string) => () => Promise<{ touched: readonly string[]; shellRuns: readonly never[] } | null>) {
    const root = mkdtempSync(join(tmpdir(), 'jamat-main-finish-port-'))
    created.push(root)
    const entry = (name: string) => ({ absolutePath: join(root, name), repositoryPath: name, nodeKind: 'file' as const, status: 'modified' as const,
      previousAbsolutePath: null, previousRepositoryPath: null, gitState: null })
    const svn: FileChangesVcs = {
      id: 'svn',
      defaultBaselineRef: { kind: 'svn-base', revision: 'BASE' },
      historyBaselineRef: (revision: string) => ({ kind: 'svn-revision' as const, revision }),
      async detect(directory) { return { id: 'svn', root, cwd: directory, scopeRelativePath: '.', scopeUrl: null, repositoryPathPrefix: null } },
      async status() { return { ok: true, value: { externalRoots: [], entries: ['own.ts', 'early.ts', 'foreign.ts'].map(entry) } } },
      async history() { return { ok: true, value: [] } },
      async readBaseline() { return { kind: 'content', content: '' } },
    }
    const load = vi.fn(async () => [{ groupId: 'g', message: 'm', createdAt: 1, mutations: [{ mutationId: 'own', kind: 'update' as const,
      status: 'modified' as const, path: join(root, 'own.ts'), previousPath: null, location: 'workspace' as const, beforeContent: null,
      afterContent: null, oldText: null, newText: null, replaceAll: false, unifiedDiff: null, createdAt: 1 }] }])
    const fileChanges = new FileChangesManager({
      diffExecutor: new FileDiffComputer(),
      vcsAdapters: [svn],
      transcriptResolver: { async resolve(input) { return { agentId: input.agentId, nativeSessionId: input.nativeSessionId, file: 'x', mtimeMs: 0, size: 0 } },
        async subagentFiles() { return [] } },
      logReaders: [{ agentId: 'claude', subagentsSince: () => null, async shellRuns() { return [] }, load }],
    })
    const uncommitted = { claims: vi.fn(claimsOf(root)) }
    const adapter = new MainFinishPortAdapter({
      sessions: { workingContext: async () => ({ ok: true as const, value: { cwd: root, agent: { agentId: 'claude' as const, nativeSessionId: 'native' } } }) } as never,
      fileChanges,
      terminal: { deliver: async () => ({ ok: true as const, value: undefined }) } as never,
      transcripts: { read: async () => null } as never,
      commits: { discovery: () => ({ revision: 0, pending: [], results: [] }) } as never,
      uncommitted,
      commandOf: () => 'commit',
    })
    return { adapter, uncommitted, load }
  }

  it('takes the session\'s paths from the worker\'s claims, filtered by the status', async () => {
    const { adapter, uncommitted, load } = adapterOf((root) => async () => ({ touched: [join(root, 'early.ts'), join(root, 'committed.ts')], shellRuns: [] }))
    expect(await adapter.changes('session-1')).toEqual({ ok: true, vcs: 'svn', paths: ['early.ts'] })
    expect(uncommitted.claims).toHaveBeenCalledWith('session-1')
    expect(load).not.toHaveBeenCalled()
  })

  it('reads the transcript itself when the worker knows no claims or failed', async () => {
    for (const claims of [async () => null, async () => { throw new Error('The session uncommitted worker is stopping') }]) {
      const { adapter, load } = adapterOf(() => claims)
      expect(await adapter.changes('session-1')).toEqual({ ok: true, vcs: 'svn', paths: ['own.ts'] })
      expect(load).toHaveBeenCalledTimes(1)
    }
  })
})
