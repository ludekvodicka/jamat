import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { ProviderTranscriptRef } from '../../projectManager/providerTranscriptView'
import type { SessionModelContext } from '../sessionModelSource'
import { ClaudeTranscriptFixtures } from './fixtures/claudeTranscriptFixtures'
import { SessionModelSourceClaude } from './sessionModelSourceClaude'

describe('lib-orchestrator/sessionModelReader/claude/sessionModelSourceClaude', () => {
  const created: string[] = []
  const sonnet = 'claude-sonnet-4-5-20260101'

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  interface World {
    ref: ProviderTranscriptRef
    cwd: string
    home: string
    context: SessionModelContext
    /** The same session as one this client started with a model named on the command line. */
    launchedOn(model: string): SessionModelContext
  }

  function world(content: string): World {
    const cwd = mkdtempSync(join(tmpdir(), 'jamat-claude-source-'))
    const home = mkdtempSync(join(tmpdir(), 'jamat-claude-home-'))
    created.push(cwd, home)
    const file = join(cwd, 'transcript.jsonl')
    writeFileSync(file, content, 'utf8')
    const stats = statSync(file)
    const context: SessionModelContext = {
      agentId: 'claude',
      cwd,
      nativeSessionId: 'session',
      launchModel: null,
    }
    return {
      ref: { agentId: 'claude', nativeSessionId: 'session', file, mtimeMs: stats.mtimeMs, size: stats.size },
      cwd,
      home,
      context,
      launchedOn: (model) => ({ ...context, launchModel: model }),
    }
  }

  it('skips the synthetic turn and sums the three usage fields of the last real one', async () => {
    const { ref, context, home } = world(
      ClaudeTranscriptFixtures.assistantTurn(sonnet, {
        input_tokens: 1_000,
        cache_read_input_tokens: 20_000,
        cache_creation_input_tokens: 5_000,
      })
      + ClaudeTranscriptFixtures.syntheticTurn(),
    )
    expect(await new SessionModelSourceClaude(home).read(ref, context)).toEqual({
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
    const { ref, context, home } = world(
      ClaudeTranscriptFixtures.assistantTurn(sonnet, { input_tokens: 1_000 })
      + '{"type":"assistant","message":{',
    )
    expect(await new SessionModelSourceClaude(home).read(ref, context))
      .toMatchObject({ kind: 'ok', info: { contextTokens: 1_000 } })
  })

  it('answers none for a transcript that has only ever said synthetic things', async () => {
    const { ref, context, home } = world(ClaudeTranscriptFixtures.syntheticTurn().repeat(3))
    expect(await new SessionModelSourceClaude(home).read(ref, context)).toEqual({
      kind: 'none',
      reason: 'no real assistant turn in the transcript tail',
    })
  })

  it('lets a compact boundary newer than the last turn override the token count', async () => {
    const { ref, context, home } = world(
      ClaudeTranscriptFixtures.assistantTurn(sonnet, { input_tokens: 940_000 })
      + ClaudeTranscriptFixtures.compactBoundary(21_000),
    )
    const reading = await new SessionModelSourceClaude(home).read(ref, context)
    expect(reading).toMatchObject({ kind: 'ok', info: { model: sonnet, contextTokens: 21_000 } })
  })

  it('keeps a real turn written after the compact, whose own usage is the fresh truth', async () => {
    const { ref, context, home } = world(
      ClaudeTranscriptFixtures.assistantTurn(sonnet, { input_tokens: 940_000 })
      + ClaudeTranscriptFixtures.compactBoundary(21_000)
      + ClaudeTranscriptFixtures.assistantTurn(sonnet, { input_tokens: 23_500 }),
    )
    expect(await new SessionModelSourceClaude(home).read(ref, context))
      .toMatchObject({ kind: 'ok', info: { contextTokens: 23_500 } })
  })

  it('returns the model and the tokens of a family that has no window in the table', async () => {
    const { ref, context, home } = world(
      ClaudeTranscriptFixtures.assistantTurn('claude-orion-9-1-20270101', { input_tokens: 90_000 }),
    )
    expect(await new SessionModelSourceClaude(home).read(ref, context)).toEqual({
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
    const { ref, context, home } = world(
      ClaudeTranscriptFixtures.assistantTurn(sonnet, { input_tokens: 4_200 })
      + ClaudeTranscriptFixtures.padding(300 * 1_024),
    )
    expect(ref.size).toBeGreaterThan(262_144)
    expect(await new SessionModelSourceClaude(home).read(ref, context))
      .toMatchObject({ kind: 'ok', info: { model: sonnet, contextTokens: 4_200 } })
  })

  it('answers none when even the second pass does not reach the turn', async () => {
    const { ref, context, home } = world(
      ClaudeTranscriptFixtures.assistantTurn(sonnet, { input_tokens: 4_200 })
      + ClaudeTranscriptFixtures.padding(1_100 * 1_024),
    )
    expect(ref.size).toBeGreaterThan(1_048_576)
    expect(await new SessionModelSourceClaude(home).read(ref, context))
      .toMatchObject({ kind: 'none' })
  })

  it('carries the effort the project configured, read from the session cwd', async () => {
    const { ref, cwd, context, home } = world(
      ClaudeTranscriptFixtures.assistantTurn(sonnet, { input_tokens: 10 }),
    )
    mkdirSync(join(cwd, '.claude'), { recursive: true })
    writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({ effortLevel: 'high' }), 'utf8')
    expect(await new SessionModelSourceClaude(home).read(ref, context))
      .toMatchObject({ kind: 'ok', info: { effortLevel: 'high' } })
  })

  // The home file said `xhigh` while `modelSettings` set `high` for this model, and the status bar
  // drew `xhigh` for a session that ran every turn on `high`.
  it('takes the effort the transcript recorded over the one the settings configure', async () => {
    const { ref, context, home } = world(
      ClaudeTranscriptFixtures.assistantTurn(sonnet, { input_tokens: 10 }, 'high'),
    )
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ effortLevel: 'xhigh' }), 'utf8')
    expect(await new SessionModelSourceClaude(home).read(ref, context))
      .toMatchObject({ kind: 'ok', info: { effortLevel: 'high' } })
  })

  // Claude Code records the id the API answered with, never the tier: this session ran on the
  // million and its transcript says `claude-opus-5`, so 91k of it was drawn as 46 percent of a
  // fifth of the window, with a compact offered and auto-compact fired at 9 percent of it.
  it('widens the window to the million the settings named for this model', async () => {
    const { ref, context, home } = world(
      ClaudeTranscriptFixtures.assistantTurn('claude-opus-5', { input_tokens: 91_262 }),
    )
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ model: 'opus[1m]' }), 'utf8')
    expect(await new SessionModelSourceClaude(home).read(ref, context))
      .toMatchObject({ kind: 'ok', info: { contextWindow: 1_000_000, contextTokens: 91_262 } })
  })

  /*
   * The case Claude's own settings cannot answer, and the one this client is in whenever the model
   * is chosen HERE: nothing writes `[1m]` into `~/.claude/settings.json`, the session is started
   * with `--model claude-opus-5[1m]` instead, and the transcript still says `claude-opus-5`. The
   * launch is the only witness left.
   */
  it('widens the window to the million the launch named, with the settings silent', async () => {
    const { ref, launchedOn, home } = world(
      ClaudeTranscriptFixtures.assistantTurn('claude-opus-5', { input_tokens: 58_000 }),
    )
    expect(await new SessionModelSourceClaude(home).read(ref, launchedOn('claude-opus-5[1m]')))
      .toMatchObject({ kind: 'ok', info: { contextWindow: 1_000_000, contextTokens: 58_000 } })
  })

  // `--model` overrides the settings file for the agent, so it overrides it here too: a launch that
  // named a tierless model is evidence AGAINST the tier the settings still name.
  it('lets a launch without a tier keep the smaller window over a settings file that names one', async () => {
    const { ref, launchedOn, home } = world(
      ClaudeTranscriptFixtures.assistantTurn('claude-opus-5', { input_tokens: 58_000 }),
    )
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ model: 'opus[1m]' }), 'utf8')
    expect(await new SessionModelSourceClaude(home).read(ref, launchedOn('opus')))
      .toMatchObject({ kind: 'ok', info: { contextWindow: 200_000 } })
  })

  // The same rule the settings model has always had: `/model` moves a running session off what it
  // was started with, and the transcript is what says where it ended up.
  it('ignores a launch model that does not name the model in the transcript', async () => {
    const { ref, launchedOn, home } = world(
      ClaudeTranscriptFixtures.assistantTurn(sonnet, { input_tokens: 58_000 }),
    )
    expect(await new SessionModelSourceClaude(home).read(ref, launchedOn('claude-opus-5[1m]')))
      .toMatchObject({ kind: 'ok', info: { contextWindow: 200_000 } })
  })

  // A session launched on `claude-opus-5` and moved by `/model` onto `Opus 5.5 (1M context)` drew
  // 200k: only the switch confirmation in the transcript says which tier it landed on.
  it('takes the tier from the /model switch that named the model in the transcript', async () => {
    const { ref, launchedOn, home } = world(
      ClaudeTranscriptFixtures.modelSwitch('Opus 5.5 (1M context) (default)')
      + ClaudeTranscriptFixtures.padding(300_000)
      + ClaudeTranscriptFixtures.assistantTurn('claude-opus-5-5', { input_tokens: 250_000 }),
    )
    expect(await new SessionModelSourceClaude(home).read(ref, launchedOn('claude-opus-5')))
      .toMatchObject({ kind: 'ok', info: { contextWindow: 1_000_000, modelLabel: 'Opus 5.5' } })
  })

  it('lets a /model switch without a tier override a launch that named one', async () => {
    const { ref, launchedOn, home } = world(
      ClaudeTranscriptFixtures.modelSwitch('Opus 5')
      + ClaudeTranscriptFixtures.assistantTurn('claude-opus-5', { input_tokens: 1_000 }),
    )
    expect(await new SessionModelSourceClaude(home).read(ref, launchedOn('claude-opus-5[1m]')))
      .toMatchObject({ kind: 'ok', info: { contextWindow: 200_000 } })
  })

  it('lets a /model switch without a tier override the default million of Opus 5.5', async () => {
    const { ref, context, home } = world(
      ClaudeTranscriptFixtures.modelSwitch('Opus 5.5')
      + ClaudeTranscriptFixtures.assistantTurn('claude-opus-5-5', { input_tokens: 1_000 }),
    )
    expect(await new SessionModelSourceClaude(home).read(ref, context))
      .toMatchObject({ kind: 'ok', info: { contextWindow: 200_000 } })
  })

  it('ignores a /model switch that named another model', async () => {
    const { ref, context, home } = world(
      ClaudeTranscriptFixtures.modelSwitch('Opus 5.5 (1M context)')
      + ClaudeTranscriptFixtures.assistantTurn('claude-opus-5', { input_tokens: 1_000 }),
    )
    expect(await new SessionModelSourceClaude(home).read(ref, context))
      .toMatchObject({ kind: 'ok', info: { contextWindow: 200_000 } })
  })

  // Session 44e51484, 2026-10-13: started by this app with no model, so Claude's settings
  // (`"model": "opus"`) were the configured model, while the transcript said `claude-fable-5-1`.
  // The settings named another family, which is no tier for this one, and Fable 5.1 runs on the
  // million by default; it was drawn against 200k.
  it('keeps the default million of Fable 5.1 under a settings file that names another model', async () => {
    const { ref, context, home } = world(
      ClaudeTranscriptFixtures.assistantTurn('claude-fable-5-1', { input_tokens: 210_000 }),
    )
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ model: 'opus' }), 'utf8')
    expect(await new SessionModelSourceClaude(home).read(ref, context))
      .toMatchObject({ kind: 'ok', info: { contextWindow: 1_000_000, modelLabel: 'Fable 5.1' } })
  })

  it('leaves the window alone when the settings name a different model', async () => {
    const { ref, context, home } = world(
      ClaudeTranscriptFixtures.assistantTurn(sonnet, { input_tokens: 91_262 }),
    )
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ model: 'opus[1m]' }), 'utf8')
    expect(await new SessionModelSourceClaude(home).read(ref, context))
      .toMatchObject({ kind: 'ok', info: { contextWindow: 200_000 } })
  })

  // The reader's cache key is the transcript's own stat plus this salt. Without the model in it, a
  // session switched to the 1M tier kept the window it was read with until the file moved again.
  it('carries both settings and the launch model in the cache salt', async () => {
    const { context, launchedOn, home } = world(
      ClaudeTranscriptFixtures.assistantTurn(sonnet, { input_tokens: 10 }),
    )
    const source = new SessionModelSourceClaude(home)
    const bare = await source.cacheSaltOf(context)
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ model: 'opus[1m]' }), 'utf8')
    const withModel = await source.cacheSaltOf(context)
    writeFileSync(
      join(home, 'settings.json'),
      JSON.stringify({ model: 'opus[1m]', effortLevel: 'max' }),
      'utf8',
    )
    const withEffort = await source.cacheSaltOf(context)
    const withLaunch = await source.cacheSaltOf(launchedOn('claude-opus-5[1m]'))
    expect(new Set([bare, withModel, withEffort, withLaunch]).size).toBe(4)
  })

  // A session past the smaller window cannot be on it. The guess said 200k for a model with no
  // tier named anywhere; the transcript proves otherwise, without any table having to know it.
  it('raises a two-hundred-thousand guess to the million once the session holds more', async () => {
    const { ref, context, home } = world(
      ClaudeTranscriptFixtures.assistantTurn(sonnet, { input_tokens: 200_001 }),
    )
    expect(await new SessionModelSourceClaude(home).read(ref, context))
      .toMatchObject({ kind: 'ok', info: { contextWindow: 1_000_000 } })
  })

  describe('the status line snapshot', () => {
    function snapshots(content: unknown): string {
      const directory = mkdtempSync(join(tmpdir(), 'jamat-claude-context-'))
      created.push(directory)
      writeFileSync(join(directory, 'session.json'),
        typeof content === 'string' ? content : JSON.stringify(content), 'utf8')
      return directory
    }

    // What the relay stores is Claude Code's own window, so it beats every guess in both
    // directions: a sonnet guessed at 200k, an Opus 5.5 guessed at its default million.
    it('takes the window Claude Code stated over every guess', async () => {
      const sonnetWorld = world(ClaudeTranscriptFixtures.assistantTurn(sonnet, { input_tokens: 10 }))
      expect(await new SessionModelSourceClaude(sonnetWorld.home, snapshots({
        schemaVersion: 1, model: `${sonnet}[1m]`, contextWindowSize: 1_000_000,
      })).read(sonnetWorld.ref, sonnetWorld.context))
        .toMatchObject({ kind: 'ok', info: { contextWindow: 1_000_000 } })
      const opusWorld = world(ClaudeTranscriptFixtures.assistantTurn('claude-opus-5-5', { input_tokens: 10 }))
      expect(await new SessionModelSourceClaude(opusWorld.home, snapshots({
        schemaVersion: 1, model: 'claude-opus-5-5', contextWindowSize: 200_000,
      })).read(opusWorld.ref, opusWorld.context))
        .toMatchObject({ kind: 'ok', info: { contextWindow: 200_000 } })
    })

    // Just after `/model` the status line already speaks for the new model while the last turn
    // in the transcript still ran on the old one.
    it('ignores a snapshot of another model than the turn ran on', async () => {
      const { ref, context, home } = world(ClaudeTranscriptFixtures.assistantTurn(sonnet, { input_tokens: 10 }))
      expect(await new SessionModelSourceClaude(home, snapshots({
        schemaVersion: 1, model: 'claude-opus-5-5[1m]', contextWindowSize: 1_000_000,
      })).read(ref, context))
        .toMatchObject({ kind: 'ok', info: { contextWindow: 200_000 } })
    })

    it('falls back to the guess for a snapshot it cannot read', async () => {
      for (const content of [
        '{"schemaVersion":1,"model":"claude-sonnet-4-5-2026',
        { schemaVersion: 2, model: sonnet, contextWindowSize: 1_000_000 },
        { schemaVersion: 1, model: sonnet, contextWindowSize: 0 },
        { schemaVersion: 1, contextWindowSize: 1_000_000 },
      ]) {
        const { ref, context, home } = world(ClaudeTranscriptFixtures.assistantTurn(sonnet, { input_tokens: 10 }))
        expect(await new SessionModelSourceClaude(home, snapshots(content)).read(ref, context))
          .toMatchObject({ kind: 'ok', info: { contextWindow: 200_000 } })
      }
    })

    it('moves the cache salt when the snapshot changes', async () => {
      const { context, home } = world(ClaudeTranscriptFixtures.assistantTurn(sonnet, { input_tokens: 10 }))
      const directory = snapshots({ schemaVersion: 1, model: sonnet, contextWindowSize: 200_000 })
      const source = new SessionModelSourceClaude(home, directory)
      const before = await source.cacheSaltOf(context)
      writeFileSync(join(directory, 'session.json'),
        JSON.stringify({ schemaVersion: 1, model: sonnet, contextWindowSize: 1_000_000 }), 'utf8')
      expect(await source.cacheSaltOf(context)).not.toBe(before)
    })
  })

  it('answers none instead of throwing when the transcript is not there to read', async () => {
    const { ref, context, home } = world(
      ClaudeTranscriptFixtures.assistantTurn(sonnet, { input_tokens: 10 }),
    )
    rmSync(ref.file)
    expect(await new SessionModelSourceClaude(home).read(ref, context)).toMatchObject({ kind: 'none' })
  })
})
