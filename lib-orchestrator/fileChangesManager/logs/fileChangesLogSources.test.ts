import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { ProviderTranscriptRef } from '../../projectManager/providerTranscriptView'
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
    )

    expect(groups).to.have.length(2)
    // Its own record carried no time, so it inherited the one before it - a real moment seconds after
    // the first group, rather than the position `3` that used to land it in 1970.
    expect(groups[1].createdAt).to.be.greaterThanOrEqual(groups[0].createdAt)
    expect(groups[1].createdAt - groups[0].createdAt).to.be.lessThan(60_000)
  })
})
