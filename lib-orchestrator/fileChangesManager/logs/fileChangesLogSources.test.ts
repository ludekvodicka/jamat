import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type {
  ProviderSubagentFileRef,
  ProviderTranscriptRef,
} from '../../projectManager/providerTranscriptView'
import type { FileChangesLogGroup } from './fileChangesLogSource.types'
import { FileChangesLogSourceClaude } from './fileChangesLogSourceClaude'
import { FileChangesLogSourceCodex } from './fileChangesLogSourceCodex'

describe('lib-orchestrator/fileChangesManager/logs/fileChangesLogSources', () => {
  function ref(agentId: 'claude' | 'codex', name: string): ProviderTranscriptRef {
    const file = join(import.meta.dirname, 'fixtures', name)
    const stats = statSync(file)
    return { agentId, nativeSessionId: 'fixture', file, mtimeMs: stats.mtimeMs, size: stats.size }
  }

  it('groups only successful Claude Edit and Write tools under real user messages', async () => {
    const groups = await new FileChangesLogSourceClaude().load(
      ref('claude', 'claude-file-changes.jsonl'),
      'Q:/Project',
      [],
    )
    expect(groups).toEqual([
      expect.objectContaining({
        groupId: 'message-one',
        mutations: [expect.objectContaining({
          path: expect.stringMatching(/Project[\\/]src[\\/]file\.ts$/i),
          location: 'workspace',
          oldText: 'old',
          newText: 'new',
        })],
      }),
      expect.objectContaining({
        groupId: 'message-two',
        mutations: [expect.objectContaining({
          path: expect.stringMatching(/External[\\/]new\.txt$/i),
          location: 'external',
          afterContent: 'content',
        })],
      }),
    ])
    expect(readFileSync(ref('claude', 'claude-file-changes.jsonl').file, 'utf8')).toContain('write-failed')
  })

  it('deduplicates Codex messages, filters injected and failed records, and preserves moves', async () => {
    const groups = await new FileChangesLogSourceCodex().load(
      ref('codex', 'codex-file-changes.jsonl'),
      'Q:/Project',
      [],
    )
    expect(groups).toHaveLength(2)
    expect(groups[0]).toEqual(expect.objectContaining({
      message: 'Change files',
      mutations: [
        expect.objectContaining({ location: 'workspace', kind: 'update' }),
        expect.objectContaining({ location: 'external', kind: 'add' }),
      ],
    }))
    expect(groups[1]).toEqual(expect.objectContaining({
      message: 'Move it',
      mutations: [expect.objectContaining({
        kind: 'move',
        status: 'renamed',
        path: expect.stringMatching(/External[\\/]moved\.txt$/i),
        previousPath: expect.stringMatching(/External[\\/]new\.txt$/i),
      })],
    }))
  })

  /**
   * The change types come from Codex's own on-disk format, not from this tree, so a fourth one is a
   * release away rather than a bug. Thrown, it escaped the whole parse: the session lost every group,
   * including the ones already read correctly, and the cache is filled after the parse so the next
   * listing read the file and threw again.
   */
  it('skips a Codex change it does not recognise and keeps everything else', async () => {
    const groups = await new FileChangesLogSourceCodex().load(
      ref('codex', 'codex-unknown-change.jsonl'),
      'Q:/Project',
      [],
    )

    expect(groups.map((group) => group.message)).to.deep.equal(['Change files', 'And again'])
    expect(groups[1].mutations).to.have.length(1)
    expect(groups[1].mutations[0].path.replace(/\\/g, '/')).to.contain('src/kept.ts')
  })

  /**
   * A record whose timestamp is missing takes the previous record's, because these files are written
   * in order. It used to take the record's POSITION in the file - `createdAt: 3`, which draws as a
   * date in 1970 and sorts to the far end of the history, past the first page and out of sight.
   */
  it('gives a record with no readable time the one before it, not its position', async () => {
    const groups = await new FileChangesLogSourceCodex().load(
      ref('codex', 'codex-untimed.jsonl'),
      'Q:/Project',
      [],
    )

    expect(groups).to.have.length(2)
    // Its own record carried no time, so it inherited the one before it - a real moment seconds after
    // the first group, rather than the position `3` that used to land it in 1970.
    expect(groups[1].createdAt).to.be.greaterThanOrEqual(groups[0].createdAt)
    expect(groups[1].createdAt - groups[0].createdAt).to.be.lessThan(60_000)
  })

  describe('sub-agents', () => {
    function subagent(
      agentId: 'claude' | 'codex',
      name: string,
      subagentId: string,
      spawnKey: string | null,
    ): ProviderSubagentFileRef {
      const file = join(import.meta.dirname, 'fixtures', name)
      const stats = statSync(file)
      return {
        agentId,
        subagentId,
        file,
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        metaFile: null,
        spawnKey,
        workflowId: null,
        thread: null,
      }
    }

    const claudeParent = (): ProviderTranscriptRef => ref('claude', 'claude-subagent-edits/parent.jsonl')
    const agentA = (): ProviderSubagentFileRef =>
      subagent('claude', 'claude-subagent-edits/agent-a.jsonl', 'a', 'toolu_agent_a')
    const agentB = (): ProviderSubagentFileRef =>
      subagent('claude', 'claude-subagent-edits/agent-b.jsonl', 'b', 'toolu_agent_b')

    function summary(groups: readonly FileChangesLogGroup[]): { groupId: string; mutations: string[] }[] {
      return groups.map((group) => ({
        groupId: group.groupId,
        mutations: group.mutations.map((mutation) =>
          `${mutation.mutationId} ${mutation.path.replace(/\\/g, '/').split('/').pop()}`),
      }))
    }

    it('files a confirmed sub-agent Edit under the message that called Agent, and not its failed Write', async () => {
      const groups = await new FileChangesLogSourceClaude().load(claudeParent(), 'Q:/Project', [agentA()])

      expect(summary(groups)).to.deep.equal([
        { groupId: 'message-one', mutations: ['own-edit own.ts'] },
        { groupId: 'message-two', mutations: ['a:edit-a a.ts'] },
      ])
      expect(groups[1].mutations[0]).toEqual(expect.objectContaining({
        kind: 'update',
        oldText: 'old',
        newText: 'from a',
        location: 'workspace',
      }))
    })

    it('files two sub-agents from two messages each under its own message', async () => {
      const groups = await new FileChangesLogSourceClaude().load(
        claudeParent(),
        'Q:/Project',
        [agentB(), agentA()],
      )

      expect(summary(groups)).to.deep.equal([
        { groupId: 'message-one', mutations: ['own-edit own.ts'] },
        { groupId: 'message-two', mutations: ['a:edit-a a.ts'] },
        { groupId: 'message-three', mutations: ['b:edit-a b.txt'] },
      ])
      expect(groups[2].mutations[0].location).to.equal('external')
    })

    it('files a sub-agent whose spawn is not found under the message active at its first record', async () => {
      const source = new FileChangesLogSourceClaude()
      for (const spawnKey of ['toolu_unknown', null]) {
        const groups = await source.load(claudeParent(), 'Q:/Project', [
          subagent('claude', 'claude-subagent-edits/agent-orphan.jsonl', 'orphan', spawnKey),
        ])

        expect(summary(groups)).to.deep.equal([
          { groupId: 'message-one', mutations: ['own-edit own.ts', 'orphan:edit-orphan orphan.ts'] },
        ])
      }
    })

    it('never changes the cached parent: a second load gives the same groups', async () => {
      const source = new FileChangesLogSourceClaude()
      const first = await source.load(claudeParent(), 'Q:/Project', [agentA(), agentB()])
      const second = await source.load(claudeParent(), 'Q:/Project', [agentA(), agentB()])
      const alone = await source.load(claudeParent(), 'Q:/Project', [])

      expect(second).to.deep.equal(first)
      expect(summary(alone)).to.deep.equal([{ groupId: 'message-one', mutations: ['own-edit own.ts'] }])
    })

    it('files a Codex child\'s applied patches under the message that spawned it', async () => {
      const source = new FileChangesLogSourceCodex()
      const parent = ref('codex', 'codex-child-patches/rollout-2026-08-14T10-00-00-0198a000-0000-7000-8000-000000000001.jsonl')
      const child = subagent(
        'codex',
        'codex-child-patches/rollout-2026-08-14T10-00-03-0198a000-0000-7000-8000-000000000002.jsonl',
        '0198a000-0000-7000-8000-000000000002',
        '0198a000-0000-7000-8000-000000000002',
      )

      const groups = await source.load(parent, 'Q:/Project', [child])

      expect(groups.map((group) => group.message)).to.deep.equal(['Spawn a helper', 'Next'])
      expect(summary(groups).map((group) => group.mutations)).to.deep.equal([
        [
          '0198a000-0000-7000-8000-000000000002:exec-child-0 child.ts',
          '0198a000-0000-7000-8000-000000000002:patch-legacy-0 legacy.ts',
        ],
        ['exec-own-0 own.ts'],
      ])
      expect(source.subagentsSince(parent)).to.equal(Date.parse('2026-08-14T10:00:00'))
    })
  })
})
