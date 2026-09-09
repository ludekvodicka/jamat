import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { ProviderTranscriptRef } from '../../projectManager/providerTranscriptView'
import { CodexRolloutFixtures } from './fixtures/codexRolloutFixtures'
import { SessionModelSourceCodex } from './sessionModelSourceCodex'

describe('lib-orchestrator/sessionModelReader/codex/sessionModelSourceCodex', () => {
  const created: string[] = []

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  function refOf(file: string): ProviderTranscriptRef {
    const stats = statSync(file)
    return { agentId: 'codex', nativeSessionId: 'session', file, mtimeMs: stats.mtimeMs, size: stats.size }
  }

  function rollout(content: string): ProviderTranscriptRef {
    const directory = mkdtempSync(join(tmpdir(), 'jamat-codex-source-'))
    created.push(directory)
    const file = join(directory, 'rollout.jsonl')
    writeFileSync(file, content, 'utf8')
    return refOf(file)
  }

  it('pairs the captured rollout, taking the last token_count under its turn_context', async () => {
    const file = join(import.meta.dirname, 'fixtures', CodexRolloutFixtures.sampleFileName())
    expect(await new SessionModelSourceCodex().read(refOf(file)))
      .toEqual({ kind: 'ok', info: CodexRolloutFixtures.sampleAnswer() })
  })

  it('leaves the last complete pair standing under a newer turn_context with no count yet', async () => {
    const ref = rollout(
      CodexRolloutFixtures.turnContext('gpt-5.4', { effort: 'high' })
      + CodexRolloutFixtures.tokenCount(200)
      + CodexRolloutFixtures.turnContext('gpt-5.6-sol', { effort: 'max' }),
    )
    expect(await new SessionModelSourceCodex().read(ref)).toEqual({
      kind: 'ok',
      info: {
        model: 'gpt-5.4',
        modelLabel: 'GPT-5.4',
        effortLevel: 'high',
        contextTokens: 200,
        contextWindow: 258_400,
      },
    })
  })

  // The count closes the pair on its own. V1 threw the reading away for a window Codex had not
  // stated, and the widget went blank for a model whose name and tokens were right there.
  it('keeps the model and the tokens when Codex states no context window', async () => {
    const ref = rollout(
      CodexRolloutFixtures.turnContext('gpt-5.4', { effort: 'high' })
      + CodexRolloutFixtures.tokenCount(200, 0),
    )
    expect(await new SessionModelSourceCodex().read(ref)).toEqual({
      kind: 'ok',
      info: {
        model: 'gpt-5.4',
        modelLabel: 'GPT-5.4',
        effortLevel: 'high',
        contextTokens: 200,
        contextWindow: null,
      },
    })
  })

  it('never pairs a count with settings written after it', async () => {
    const ref = rollout(
      CodexRolloutFixtures.tokenCount(999)
      + CodexRolloutFixtures.turnContext('gpt-5.4', { effort: 'high' }),
    )
    expect(await new SessionModelSourceCodex().read(ref)).toEqual({
      kind: 'none',
      reason: 'no complete turn_context/token_count pair',
    })
  })

  it('reads the two older effort keys as well as the current one', async () => {
    const legacy = rollout(
      CodexRolloutFixtures.turnContext('gpt-5.1-codex-max', { reasoning_effort: 'xhigh' })
      + CodexRolloutFixtures.tokenCount(50),
    )
    expect(await new SessionModelSourceCodex().read(legacy)).toMatchObject({
      kind: 'ok',
      info: { effortLevel: 'xhigh', modelLabel: 'GPT-5.1 Codex Max' },
    })

    const nested = rollout(
      CodexRolloutFixtures.turnContext('gpt-5.2', {
        collaboration_mode: { settings: { reasoning_effort: 'medium' } },
      })
      + CodexRolloutFixtures.tokenCount(60),
    )
    expect(await new SessionModelSourceCodex().read(nested))
      .toMatchObject({ kind: 'ok', info: { effortLevel: 'medium' } })

    const none = rollout(
      CodexRolloutFixtures.turnContext('gpt-5.3', {}) + CodexRolloutFixtures.tokenCount(7, 400_000),
    )
    expect(await new SessionModelSourceCodex().read(none))
      .toMatchObject({ kind: 'ok', info: { effortLevel: null, contextWindow: 400_000 } })
  })

  it('reads the whole file once when the tail holds a count whose settings fell off it', async () => {
    const ref = rollout(
      CodexRolloutFixtures.turnContext('gpt-5.4', { effort: 'high' })
      + CodexRolloutFixtures.padding(600 * 1_024)
      + CodexRolloutFixtures.tokenCount(1_234),
    )
    expect(ref.size).toBeGreaterThan(524_288)
    expect(await new SessionModelSourceCodex().read(ref))
      .toMatchObject({ kind: 'ok', info: { model: 'gpt-5.4', contextTokens: 1_234 } })
  })

  it('answers none when no settings exist anywhere in the file, and when the model is missing', async () => {
    const countsOnly = rollout(CodexRolloutFixtures.tokenCount(10) + CodexRolloutFixtures.tokenCount(20))
    expect(await new SessionModelSourceCodex().read(countsOnly)).toMatchObject({ kind: 'none' })

    const modelless = rollout(
      CodexRolloutFixtures.row('turn_context', { effort: 'high' }) + CodexRolloutFixtures.tokenCount(10),
    )
    expect(await new SessionModelSourceCodex().read(modelless)).toMatchObject({ kind: 'none' })
  })

  it('walks past a malformed row and past a count it cannot believe', async () => {
    const ref = rollout(
      CodexRolloutFixtures.turnContext('gpt-5.4', { effort: 'high' })
      + CodexRolloutFixtures.tokenCount(40)
      + '{malformed json]\n'
      + CodexRolloutFixtures.tokenCount(-1),
    )
    expect(await new SessionModelSourceCodex().read(ref))
      .toMatchObject({ kind: 'ok', info: { contextTokens: 40 } })
  })

  it('answers none instead of throwing when the rollout is not there to read', async () => {
    const ref = rollout(CodexRolloutFixtures.turnContext('gpt-5.4', { effort: 'high' }))
    rmSync(ref.file)
    expect(await new SessionModelSourceCodex().read(ref)).toMatchObject({ kind: 'none' })
  })
})
