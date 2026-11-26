import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { PathCompare } from '../shared/pathCompare'
import { FileDiffComputer } from './diff/fileDiffComputer'
import type { FileChangesLogGroup } from './logs/fileChangesLogSource.types'
import type { FileChangesVcs } from './vcs/fileChangesVcs.types'
import { FileChangesManager } from './fileChangesManager'
import { sessionMutationExtractor } from './sessionMutationsView'
import { FileChangesWorkingTreeSources } from './working/fileChangesWorkingTreeSources'

describe('lib-orchestrator/fileChangesManager/fileChangesManager', () => {
  const created: string[] = []

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
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
      transcriptResolver: { async resolve() { return null }, async subagentFiles() { return [] } },
      logReaders: [{ agentId: 'codex', subagentsSince: () => null, async shellRuns() { return [] }, async load() { return [] } }],
    })
  }

  it('answers the session\'s own changes: what its transcript wrote that the status still shows, also inside a new directory', async () => {
    const root = cwd()
    const entry = (name: string, nodeKind: 'file' | 'directory', status: 'modified' | 'untracked', previous: string | null = null) => ({
      absolutePath: join(root, name), repositoryPath: name, nodeKind, status,
      previousAbsolutePath: previous === null ? null : join(root, previous), previousRepositoryPath: previous, gitState: null })
    const mutation = (path: string, previousPath: string | null = null) => ({ mutationId: path, kind: previousPath === null ? 'update' as const : 'move' as const,
      status: 'modified' as const, path: join(root, path), previousPath: previousPath === null ? null : join(root, previousPath), location: 'workspace' as const,
      beforeContent: null, afterContent: null, oldText: null, newText: null, replaceAll: false, unifiedDiff: null, createdAt: 1 })
    const adapter: FileChangesVcs = { ...vcs(root), id: 'svn', async status() {
      return { ok: true, value: { externalRoots: [], entries: [entry('own.ts', 'file', 'modified'), entry('foreign.ts', 'file', 'modified'),
        entry('fresh', 'directory', 'untracked'), entry('moved.ts', 'file', 'modified', 'old.ts')] } }
    } }
    const instance = new FileChangesManager({
      diffExecutor: new FileDiffComputer(),
      vcsAdapters: [adapter],
      transcriptResolver: { async resolve(input) { return { agentId: input.agentId, nativeSessionId: input.nativeSessionId, file: 'x', mtimeMs: 0, size: 0 } },
        async subagentFiles() { return [] } },
      logReaders: [{ agentId: 'codex', subagentsSince: () => null, async shellRuns() { return [] }, async load() {
        return [{ groupId: 'g', message: 'm', createdAt: 1, mutations: [mutation('own.ts'), mutation('fresh/inner/new.ts'), mutation('moved.ts', 'old.ts'),
          mutation('reverted.ts')] }]
      } }],
    })
    const context = { sessionId: 'session', cwd: root, agent: { agentId: 'codex' as const, nativeSessionId: 'native' } }

    expect(await instance.sessionChanges(context, 'svn')).toEqual({ ok: true, value: { vcs: 'svn', paths: ['own.ts', 'fresh', 'moved.ts'] } })
    // Without an agent there is no transcript, so nothing is the session's own.
    expect(await instance.sessionChanges({ ...context, agent: null }, 'svn')).toEqual({ ok: true, value: { vcs: 'svn', paths: [] } })
  })

  it('counts a file a shell command of the session names and wrote while it ran, not one it only named or one written then by another', async () => {
    const root = cwd()
    const startedAt = 1_700_000_000_000
    const file = (name: string, modifiedAt: number | null) => {
      const path = join(root, name)
      mkdirSync(dirname(path), { recursive: true })
      if (modifiedAt === null) return
      writeFileSync(path, 'x\n', 'utf8')
      utimesSync(path, modifiedAt / 1_000, modifiedAt / 1_000)
    }
    file('src/scripted.ts', startedAt + 5_000)
    file('scripted.ts', startedAt + 5_000)
    file('abs.ts', startedAt + 9_000)
    file('read.ts', startedAt - 600_000)
    file('foreign.ts', startedAt + 5_000)
    file('gone.ts', null)
    const names = ['src/scripted.ts', 'scripted.ts', 'abs.ts', 'read.ts', 'foreign.ts', 'gone.ts']
    const adapter: FileChangesVcs = { ...vcs(root), id: 'svn', async status() {
      return { ok: true, value: { externalRoots: [], entries: names.map((name) => ({ absolutePath: join(root, name), repositoryPath: name, nodeKind: 'file' as const,
        status: name === 'gone.ts' ? 'deleted' as const : 'modified' as const, previousAbsolutePath: null, previousRepositoryPath: null, gitState: null })) } }
    } }
    // The script names `abs.ts` absolutely, as a Python string literal doubles a Windows backslash.
    const literal = join(root, 'abs.ts').replace(/\\/g, '\\\\')
    const instance = new FileChangesManager({
      diffExecutor: new FileDiffComputer(),
      vcsAdapters: [adapter],
      transcriptResolver: { async resolve(input) { return { agentId: input.agentId, nativeSessionId: input.nativeSessionId, file: 'x', mtimeMs: 0, size: 0 } },
        async subagentFiles() { return [] } },
      logReaders: [{ agentId: 'claude', subagentsSince: () => null, async load() { return [] }, async shellRuns() {
        return [
          { command: `python3 - <<'EOF'\nedit('src/scripted.ts', [('a', 'b')])\nedit('${literal}', [])\nEOF`, startedAt, endedAt: startedAt + 10_000 },
          { command: 'svn diff read.ts foreign.ts.bak && svn rm gone.ts', startedAt: startedAt + 20_000, endedAt: startedAt + 21_000 },
        ]
      } }],
    })
    const context = { sessionId: 'session', cwd: root, agent: { agentId: 'claude' as const, nativeSessionId: 'native' } }

    expect(await instance.sessionChanges(context, 'svn')).toEqual({ ok: true, value: { vcs: 'svn', paths: ['src/scripted.ts', 'abs.ts'] } })
  })

  describe('sessionChanges with a claims port', () => {
    const entryOf = (root: string, name: string) => ({ absolutePath: join(root, name), repositoryPath: name, nodeKind: 'file' as const,
      status: 'modified' as const, previousAbsolutePath: null, previousRepositoryPath: null, gitState: null })
    const mutationOf = (root: string, name: string) => ({ mutationId: name, kind: 'update' as const, status: 'modified' as const,
      path: join(root, name), previousPath: null, location: 'workspace' as const, beforeContent: null, afterContent: null,
      oldText: null, newText: null, replaceAll: false, unifiedDiff: null, createdAt: 1 })
    /** The status lists `listed`; the transcript names `logged`. */
    const instanceOf = (root: string, listed: readonly string[], logged: readonly string[]) => new FileChangesManager({
      diffExecutor: new FileDiffComputer(),
      vcsAdapters: [{ ...vcs(root), id: 'svn', async status() {
        return { ok: true, value: { externalRoots: [], entries: listed.map((name) => entryOf(root, name)) } }
      } }],
      transcriptResolver: { async resolve(input) { return { agentId: input.agentId, nativeSessionId: input.nativeSessionId, file: 'x', mtimeMs: 0, size: 0 } },
        async subagentFiles() { return [] } },
      logReaders: [{ agentId: 'codex', subagentsSince: () => null, async shellRuns() { return [] }, async load() {
        return [{ groupId: 'g', message: 'm', createdAt: 1, mutations: logged.map((name) => mutationOf(root, name)) }]
      } }],
    })
    const contextOf = (root: string) => ({ sessionId: 'session', cwd: root, agent: { agentId: 'codex' as const, nativeSessionId: 'native' } })

    it('reports a claimed path the status lists and not one it does not list', async () => {
      const root = cwd()
      const instance = instanceOf(root, ['claimed.ts', 'foreign.ts', 'logged.ts'], ['logged.ts'])
      const claims = { claims: async () => ({ touched: [join(root, 'claimed.ts'), join(root, 'committed.ts')], shellRuns: [] }) }
      expect(await instance.sessionChanges(contextOf(root), 'svn', claims)).toEqual({ ok: true, value: { vcs: 'svn', paths: ['claimed.ts'] } })
    })

    it('reads the transcript as without a port when the port answers null', async () => {
      const root = cwd()
      const instance = instanceOf(root, ['own.ts', 'foreign.ts'], ['own.ts', 'reverted.ts'])
      const today = await instance.sessionChanges(contextOf(root), 'svn')
      expect(today).toEqual({ ok: true, value: { vcs: 'svn', paths: ['own.ts'] } })
      expect(await instance.sessionChanges(contextOf(root), 'svn', { claims: async () => null })).toEqual(today)
    })

    it('leaves out a path whose claim ended although another session dirtied it since', async () => {
      const root = cwd()
      // The transcript still names `shared.ts`; its claim ended when it was committed after that
      // write, so the port's open claims no longer hold it, while the status shows another session's edit.
      const instance = instanceOf(root, ['shared.ts', 'own.ts'], ['shared.ts', 'own.ts'])
      expect(await instance.sessionChanges(contextOf(root), 'svn')).toEqual({ ok: true, value: { vcs: 'svn', paths: ['shared.ts', 'own.ts'] } })
      const claims = { claims: async () => ({ touched: [join(root, 'own.ts')], shellRuns: [] }) }
      expect(await instance.sessionChanges(contextOf(root), 'svn', claims)).toEqual({ ok: true, value: { vcs: 'svn', paths: ['own.ts'] } })
    })

    it('counts an edit more than 32 MiB back in a transcript through the claims, which the transcript read misses', async () => {
      const root = cwd()
      const transcript = join(root, 'native.jsonl')
      const at = (offset: number) => new Date(1_754_400_000_000 + offset).toISOString()
      const prompt = (text: string, offset: number) => JSON.stringify({ type: 'user', uuid: `u-${text}`, timestamp: at(offset), message: { content: text } })
      const edit = (id: string, name: string, offset: number) => [
        JSON.stringify({ type: 'assistant', timestamp: at(offset), message: { content: [
          { type: 'tool_use', id, name: 'Edit', input: { file_path: join(root, name), old_string: 'a', new_string: 'b' } }] } }),
        JSON.stringify({ type: 'user', timestamp: at(offset), message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } }),
      ].join('\n')
      const filler = JSON.stringify({ type: 'assistant', timestamp: at(2_000), message: { content: [{ type: 'text', text: 'x'.repeat(65_536) }] } })
      writeFileSync(transcript, `${prompt('early', 0)}\n${edit('e1', 'early.ts', 1_000)}\n`, 'utf8')
      for (let written = 0; written < 33 * 1_048_576; written += filler.length + 1)
        writeFileSync(transcript, `${filler}\n`, { encoding: 'utf8', flag: 'a' })
      writeFileSync(transcript, `${prompt('late', 3_000)}\n${edit('e2', 'late.ts', 4_000)}\n`, { encoding: 'utf8', flag: 'a' })
      expect(statSync(transcript).size).toBeGreaterThan(33 * 1_048_576)
      const instance = new FileChangesManager({
        diffExecutor: new FileDiffComputer(),
        vcsAdapters: [{ ...vcs(root), id: 'svn', async status() {
          return { ok: true, value: { externalRoots: [], entries: ['early.ts', 'late.ts'].map((name) => entryOf(root, name)) } }
        } }],
        transcriptResolver: { async resolve(input) {
          const stats = statSync(transcript)
          return { agentId: input.agentId, nativeSessionId: input.nativeSessionId, file: transcript, mtimeMs: stats.mtimeMs, size: stats.size }
        }, async subagentFiles() { return [] } },
      })
      const context = { sessionId: 'session', cwd: root, agent: { agentId: 'claude' as const, nativeSessionId: 'native' } }
      expect(await instance.sessionChanges(context, 'svn', { claims: async () => null })).toEqual({ ok: true, value: { vcs: 'svn', paths: ['late.ts'] } })
      // The claims port reads the whole transcript with the extractor the worker's cursor uses.
      const extractor = sessionMutationExtractor('claude', 'session')
      extractor.push(readFileSync(transcript, 'utf8').split('\n').filter((line) => line.length > 0))
      const batch = extractor.drain()
      const claims = { claims: async () => ({ touched: batch.mutations.map((mutation) => mutation.path), shellRuns: batch.shellRuns }) }
      expect(await instance.sessionChanges(context, 'svn', claims)).toEqual({ ok: true, value: { vcs: 'svn', paths: ['early.ts', 'late.ts'] } })
    })
  })

  it('lists sub-agents from the log source\'s start and files their edits under the spawning message', async () => {
    const root = cwd()
    const fixture = (name: string) => {
      const file = join(import.meta.dirname, 'logs', 'fixtures', 'claude-subagent-edits', name)
      const stats = statSync(file)
      return { file, mtimeMs: stats.mtimeMs, size: stats.size }
    }
    const asked: unknown[] = []
    const instance = new FileChangesManager({
      diffExecutor: new FileDiffComputer(),
      vcsAdapters: [vcs(root)],
      transcriptResolver: {
        async resolve(input) {
          return { agentId: input.agentId, nativeSessionId: input.nativeSessionId, ...fixture('parent.jsonl') }
        },
        async subagentFiles(input) {
          asked.push(input)
          return [{
            agentId: 'claude',
            subagentId: 'a',
            ...fixture('agent-a.jsonl'),
            metaFile: null,
            spawnKey: 'toolu_agent_a',
            workflowId: null,
            thread: null,
          }]
        },
      },
    })

    const listed = await instance.list({
      sessionId: 'session',
      cwd: root,
      agent: { agentId: 'claude', nativeSessionId: 'native' },
    })

    if (!listed.ok) throw new Error(listed.detail)
    expect(asked).to.deep.equal([{ agentId: 'claude', nativeSessionId: 'native', cwd: root, since: 0 }])
    const chat = listed.value.history.groups.filter((group) => group.groupId.startsWith('chat-message:'))
    expect(chat.map((group) => [group.groupId, group.entries.map((entry) => entry.path.replace(/\\/g, '/'))]))
      .to.deep.equal([
        ['chat-message:message-two', ['Q:/Project/src/a.ts']],
        ['chat-message:message-one', ['Q:/Project/src/own.ts']],
      ])
  })

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

  it('hands each successful SVN status of a poll to the observer once, and no Git status', async () => {
    const root = cwd()
    const observed: { root: string; entries: readonly { absolutePath: string; nodeKind: string }[] }[] = []
    const svn: FileChangesVcs = { ...vcs(root), id: 'svn' }
    const options = {
      diffExecutor: new FileDiffComputer(),
      transcriptResolver: { async resolve() { return null }, async subagentFiles() { return [] } },
      logReaders: [{ agentId: 'codex' as const, subagentsSince: () => null, async shellRuns() { return [] }, async load() { return [] } }],
      statusObserved: (observedRoot: string, entries: readonly { absolutePath: string; nodeKind: string }[]) =>
        observed.push({ root: observedRoot, entries }),
    }
    const context = { sessionId: 'session', cwd: root, agent: null }

    const polled = await new FileChangesManager({ ...options, vcsAdapters: [svn] }).list(context, { preferredVcs: 'svn' })
    expect(polled.ok).toBe(true)
    expect(observed).toEqual([{ root, entries: [{ absolutePath: join(root, 'file.ts'), nodeKind: 'file' }] }])

    await new FileChangesManager({ ...options, vcsAdapters: [vcs(root)] }).list(context)
    expect(observed).toHaveLength(1)
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
      transcriptResolver: {
        async resolve() { throw new Error('workingTree read the transcript') },
        async subagentFiles() { throw new Error('workingTree listed sub-agents') },
      },
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

  it('lists property changes of files and directories and adds a file\'s to its diff against the working baseline', async () => {
    const root = cwd()
    writeFileSync(join(root, 'binary.bin'), 'a\0b', 'utf8')
    const adapter = vcs(root)
    const detected = (await adapter.detect(root))!
    const status = await adapter.status(detected)
    if (!status.ok) throw new Error(status.detail)
    const properties = { changes: [{ name: 'jamat:test', before: 'base', after: 'w1-prop-only' }], detail: null }
    const ignore = { changes: [{ name: 'svn:ignore', before: 'x\n', after: null }], detail: null }
    const entries = [
      { ...status.value.entries[0], properties },
      { ...status.value.entries[0], absolutePath: join(root, 'binary.bin'), repositoryPath: 'binary.bin', properties },
      { ...status.value.entries[0], absolutePath: root, repositoryPath: '.', nodeKind: 'directory' as const, properties: ignore },
    ]
    const managerInstance = new FileChangesManager({
      diffExecutor: new FileDiffComputer(),
      workingSources: { read: async () => ({
        selection: { requested: 'svn', selected: 'svn', available: ['svn'], fallbackReason: null },
        selected: { adapter, detection: detected, baseline: adapter.defaultBaselineRef, baselineLabel: 'SVN BASE' },
        entries, externalRoots: [], warnings: [],
      }) } as unknown as FileChangesWorkingTreeSources,
    })

    const listed = await managerInstance.workingTree({ sessionId: 'session', cwd: root, agent: null, worktree: null }, 'svn', true)
    if (!listed.ok) throw new Error(listed.detail)
    const byName = new Map(listed.value.entries.map((entry) => [entry.displayPath, entry]))
    expect(byName.get('file.ts')?.properties).toEqual(properties)
    expect(byName.get('.')?.properties).toEqual(ignore)
    const diffOf = (path: string) => managerInstance.diff({ snapshotId: listed.value.snapshotId,
      fileId: byName.get(path)!.fileId, baselineId: listed.value.defaultBaseline!.baselineId })
    expect(await diffOf('file.ts')).toMatchObject({ ok: true, kind: 'text', data: { properties } })
    expect(await diffOf('binary.bin')).toMatchObject({ ok: true, kind: 'binary', properties })
  })

  it('rejects single-file reads outside their scope or without a commit VCS', async () => {
    const root = cwd()
    const instance = manager(root)
    const context = { sessionId: 'session', cwd: root, agent: null, worktree: null }
    expect(await instance.workingTree(context, 'svn', true, join(root, '..', 'outside.txt'))).toMatchObject({ ok: false })
    expect(await instance.workingTree(context, 'svn', false, join(root, 'file.ts'))).toMatchObject({ ok: false })
    expect(await instance.workingTree(context, 'checkpoint', true, join(root, 'file.ts'))).toMatchObject({ ok: false })
    expect(await instance.workingTree(context, 'svn', true, undefined, [join(root, '..', 'outside.txt')])).toMatchObject({ ok: false })
    expect(await instance.workingTree(context, 'svn', false, undefined, [join(root, 'file.ts')])).toMatchObject({ ok: false })
    expect(await instance.workingTree(context, 'checkpoint', true, undefined, [join(root, 'file.ts')])).toMatchObject({ ok: false })
  })

  it('hands the named commit paths to the status read, so the rest of the scope is never read', async () => {
    const root = cwd()
    const adapter = vcs(root)
    const asked: (readonly string[] | undefined)[] = []
    const originalStatus = adapter.status.bind(adapter)
    adapter.status = async (detection, filePath, targets) => {
      asked.push(targets)
      return originalStatus(detection, filePath, targets)
    }
    const managerInstance = new FileChangesManager({
      diffExecutor: new FileDiffComputer(),
      workingSources: new FileChangesWorkingTreeSources({ commitSvn: adapter }),
    })
    const context = { sessionId: 'session', cwd: root, agent: null, worktree: null }

    const listed = await managerInstance.workingTree(context, 'svn', true, undefined, [join(root, 'file.ts')])

    expect(listed).toMatchObject({ ok: true, value: { entries: [{ displayPath: 'file.ts' }] } })
    expect(asked).toEqual([[join(root, 'file.ts')]])
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
        checkpointStore: { existingContextOf: async () => ({ ok: true, value: null }) },
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
      transcriptResolver: { async resolve() { return null }, async subagentFiles() { return [] } },
      logReaders: [{ agentId: 'codex', subagentsSince: () => null, async shellRuns() { return [] }, async load() { return [] } }],
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

  it('resolves chained renames across history groups in one backwards O(M) pass', () => {
    const mutationOf = (
      mutationId: string,
      kind: 'write' | 'move',
      status: 'added' | 'renamed',
      path: string,
      previousPath: string | null,
    ): FileChangesLogGroup['mutations'][number] => ({
      mutationId,
      kind,
      status,
      path,
      previousPath,
      location: 'workspace',
      beforeContent: null,
      afterContent: null,
      oldText: null,
      newText: null,
      replaceAll: false,
      unifiedDiff: null,
      createdAt: 1,
    })
    const groups: FileChangesLogGroup[] = [
      { groupId: 'g0', message: 'create', createdAt: 1, mutations: [mutationOf('m0', 'write', 'added', 'Q:/w/a.ts', null)] },
      { groupId: 'g1', message: 'rename 1', createdAt: 2, mutations: [mutationOf('m1', 'move', 'renamed', 'Q:/w/b.ts', 'Q:/w/a.ts')] },
      { groupId: 'g2', message: 'rename 2', createdAt: 3, mutations: [mutationOf('m2', 'move', 'renamed', 'Q:/w/c.ts', 'Q:/w/b.ts')] },
    ]
    const maps = FileChangesManager.latestPathsAfterGroups(groups, 0)
    expect(maps).toHaveLength(3)
    expect(maps[0]?.get(PathCompare.comparable('Q:/w/a.ts'))).toBe('Q:/w/c.ts')
    expect(maps[1]?.get(PathCompare.comparable('Q:/w/b.ts'))).toBe('Q:/w/c.ts')
    expect(maps[2]?.size).toBe(0)
  })
})
