import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { ProviderTranscriptRef } from '../../projectManager/providerTranscriptView'
import { ClaudeTranscriptFixtures } from './fixtures/claudeTranscriptFixtures'
import { SessionModelSourceClaude } from './sessionModelSourceClaude'

describe('lib-orchestrator/sessionModelReader/claude/sessionModelSourceClaude', () => {
  const created: string[] = []
  const sonnet = 'claude-sonnet-4-5-20260101'

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  function world(content: string): { ref: ProviderTranscriptRef; cwd: string; home: string } {
    const cwd = mkdtempSync(join(tmpdir(), 'jamat-claude-source-'))
    const home = mkdtempSync(join(tmpdir(), 'jamat-claude-home-'))
    created.push(cwd, home)
    const file = join(cwd, 'transcript.jsonl')
    writeFileSync(file, content, 'utf8')
    const stats = statSync(file)
    return {
      ref: { agentId: 'claude', nativeSessionId: 'session', file, mtimeMs: stats.mtimeMs, size: stats.size },
      cwd,
      home,
    }
  }

  it('skips the synthetic turn and sums the three usage fields of the last real one', async () => {
    const { ref, cwd, home } = world(
      ClaudeTranscriptFixtures.assistantTurn(sonnet, {
        input_tokens: 1_000,
        cache_read_input_tokens: 20_000,
        cache_creation_input_tokens: 5_000,
      })
      + ClaudeTranscriptFixtures.syntheticTurn(),
    )
    expect(await new SessionModelSourceClaude(home).read(ref, cwd)).toEqual({
      kind: 'ok',
      info: {
        model: sonnet,
        modelLabel: 'Sonnet 4.5',
        effortLevel: null,
        contextTokens: 26_000,
        contextWindow: 200_000,
      },
    })
  })

  // The agent writes this file while it is being read, so its last line is regularly half a
  // record. Without the tolerance in `records` the parse throws, the catch turns it into
  // `transcript unreadable`, and one incomplete line erases a reading that was entirely there.
  it('reads the turn before a last line that is still being written', async () => {
    const { ref, cwd, home } = world(
      ClaudeTranscriptFixtures.assistantTurn(sonnet, { input_tokens: 1_000 })
      + '{"type":"assistant","message":{',
    )
    expect(await new SessionModelSourceClaude(home).read(ref, cwd))
      .toMatchObject({ kind: 'ok', info: { contextTokens: 1_000 } })
  })

  it('answers none for a transcript that has only ever said synthetic things', async () => {
    const { ref, cwd, home } = world(ClaudeTranscriptFixtures.syntheticTurn().repeat(3))
    expect(await new SessionModelSourceClaude(home).read(ref, cwd)).toEqual({
      kind: 'none',
      reason: 'no real assistant turn in the transcript tail',
    })
  })

  it('lets a compact boundary newer than the last turn override the token count', async () => {
    const { ref, cwd, home } = world(
      ClaudeTranscriptFixtures.assistantTurn(sonnet, { input_tokens: 940_000 })
      + ClaudeTranscriptFixtures.compactBoundary(21_000),
    )
    const reading = await new SessionModelSourceClaude(home).read(ref, cwd)
    expect(reading).toMatchObject({ kind: 'ok', info: { model: sonnet, contextTokens: 21_000 } })
  })

  it('keeps a real turn written after the compact, whose own usage is the fresh truth', async () => {
    const { ref, cwd, home } = world(
      ClaudeTranscriptFixtures.assistantTurn(sonnet, { input_tokens: 940_000 })
      + ClaudeTranscriptFixtures.compactBoundary(21_000)
      + ClaudeTranscriptFixtures.assistantTurn(sonnet, { input_tokens: 23_500 }),
    )
    expect(await new SessionModelSourceClaude(home).read(ref, cwd))
      .toMatchObject({ kind: 'ok', info: { contextTokens: 23_500 } })
  })

  it('returns the model and the tokens of a family that has no window in the table', async () => {
    const { ref, cwd, home } = world(
      ClaudeTranscriptFixtures.assistantTurn('claude-orion-9-1-20270101', { input_tokens: 90_000 }),
    )
    expect(await new SessionModelSourceClaude(home).read(ref, cwd)).toEqual({
      kind: 'ok',
      info: {
        model: 'claude-orion-9-1-20270101',
        modelLabel: 'Orion 9.1',
        effortLevel: null,
        contextTokens: 90_000,
        contextWindow: null,
      },
    })
  })

  it('widens to the second pass for a turn that sits deeper than the first one reaches', async () => {
    const { ref, cwd, home } = world(
      ClaudeTranscriptFixtures.assistantTurn(sonnet, { input_tokens: 4_200 })
      + ClaudeTranscriptFixtures.padding(300 * 1_024),
    )
    expect(ref.size).toBeGreaterThan(262_144)
    expect(await new SessionModelSourceClaude(home).read(ref, cwd))
      .toMatchObject({ kind: 'ok', info: { model: sonnet, contextTokens: 4_200 } })
  })

  it('answers none when even the second pass does not reach the turn', async () => {
    const { ref, cwd, home } = world(
      ClaudeTranscriptFixtures.assistantTurn(sonnet, { input_tokens: 4_200 })
      + ClaudeTranscriptFixtures.padding(1_100 * 1_024),
    )
    expect(ref.size).toBeGreaterThan(1_048_576)
    expect(await new SessionModelSourceClaude(home).read(ref, cwd))
      .toMatchObject({ kind: 'none' })
  })

  it('carries the effort the project configured, read from the session cwd', async () => {
    const { ref, cwd, home } = world(
      ClaudeTranscriptFixtures.assistantTurn(sonnet, { input_tokens: 10 }),
    )
    mkdirSync(join(cwd, '.claude'), { recursive: true })
    writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({ effortLevel: 'high' }), 'utf8')
    expect(await new SessionModelSourceClaude(home).read(ref, cwd))
      .toMatchObject({ kind: 'ok', info: { effortLevel: 'high' } })
  })

  // Claude Code records the id the API answered with, never the tier: this session ran on the
  // million and its transcript says `claude-opus-5`, so 91k of it was drawn as 46 percent of a
  // fifth of the window, with a compact offered and auto-compact fired at 9 percent of it.
  it('widens the window to the million the settings named for this model', async () => {
    const { ref, cwd, home } = world(
      ClaudeTranscriptFixtures.assistantTurn('claude-opus-5', { input_tokens: 91_262 }),
    )
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ model: 'opus[1m]' }), 'utf8')
    expect(await new SessionModelSourceClaude(home).read(ref, cwd))
      .toMatchObject({ kind: 'ok', info: { contextWindow: 1_000_000, contextTokens: 91_262 } })
  })

  it('leaves the window alone when the settings name a different model', async () => {
    const { ref, cwd, home } = world(
      ClaudeTranscriptFixtures.assistantTurn(sonnet, { input_tokens: 91_262 }),
    )
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ model: 'opus[1m]' }), 'utf8')
    expect(await new SessionModelSourceClaude(home).read(ref, cwd))
      .toMatchObject({ kind: 'ok', info: { contextWindow: 200_000 } })
  })

  // The reader's cache key is the transcript's own stat plus this salt. Without the model in it, a
  // session switched to the 1M tier kept the window it was read with until the file moved again.
  it('carries both settings in the cache salt, so a changed one is a new key', async () => {
    const { cwd, home } = world(ClaudeTranscriptFixtures.assistantTurn(sonnet, { input_tokens: 10 }))
    const source = new SessionModelSourceClaude(home)
    const bare = await source.cacheSaltOf(cwd)
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ model: 'opus[1m]' }), 'utf8')
    const withModel = await source.cacheSaltOf(cwd)
    writeFileSync(
      join(home, 'settings.json'),
      JSON.stringify({ model: 'opus[1m]', effortLevel: 'max' }),
      'utf8',
    )
    expect(new Set([bare, withModel, await source.cacheSaltOf(cwd)]).size).toBe(3)
  })

  it('answers none instead of throwing when the transcript is not there to read', async () => {
    const { ref, cwd, home } = world(ClaudeTranscriptFixtures.assistantTurn(sonnet, { input_tokens: 10 }))
    rmSync(ref.file)
    expect(await new SessionModelSourceClaude(home).read(ref, cwd)).toMatchObject({ kind: 'none' })
  })
})
