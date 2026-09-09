import { describe, expect, it } from 'vitest'

import type { SessionRecordAgent } from '../records/sessionRecord.types'
import { AgentPresets, type SessionAgentSpec } from './agentPresets'

describe('lib-orchestrator/sessionManager/launch/agentPresets', () => {
  const mintedConst = '5f6c1f5e-0f7a-4b64-9a2c-2b6a0f0d1c33'
  const parentConst = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'

  function claude(overrides: Partial<SessionAgentSpec>): SessionAgentSpec {
    return { agentId: 'claude', mode: 'new', ...overrides }
  }

  function codex(overrides: Partial<SessionAgentSpec>): SessionAgentSpec {
    return { agentId: 'codex', mode: 'new', ...overrides }
  }

  it('gives claude the minted id at launch, which is what makes a later resume deterministic', () => {
    expect(AgentPresets.createArgs(claude({ mode: 'new' }), mintedConst))
      .toEqual(['--session-id', mintedConst])
    expect(AgentPresets.mintsNativeSessionId(claude({ mode: 'new' }))).toBe(true)
  })

  it('launches claude bare when nothing was minted', () => {
    expect(AgentPresets.createArgs(claude({ mode: 'new' }), undefined)).toEqual([])
  })

  /**
   * Last and positional, because both CLIs read a trailing bare argument as the thing to answer.
   * A flag appended after it would be read as more prompt.
   */
  it('puts the initial prompt last, whatever the mode put in front of it', () => {
    const prompt = 'Merge a worktree session back into the main copy'

    expect(AgentPresets.createArgs(claude({ mode: 'new', initialPrompt: prompt }), mintedConst))
      .toEqual(['--session-id', mintedConst, prompt])
    expect(AgentPresets.createArgs(
      claude({ mode: 'fork', forkParentId: parentConst, initialPrompt: prompt }), undefined))
      .toEqual(['--resume', parentConst, '--fork-session', prompt])
    expect(AgentPresets.createArgs(codex({ mode: 'new', initialPrompt: prompt }), undefined))
      .toEqual([prompt])
    expect(AgentPresets.createArgs(
      codex({ mode: 'fork', forkParentId: parentConst, initialPrompt: prompt }), undefined))
      .toEqual(['fork', parentConst, prompt])
  })

  it('leaves the argv untouched when there is no prompt', () => {
    expect(AgentPresets.createArgs(claude({ mode: 'new', initialPrompt: undefined }), mintedConst))
      .toEqual(AgentPresets.createArgs(claude({ mode: 'new' }), mintedConst))
    expect(AgentPresets.createArgs(codex({ mode: 'continue' }), undefined))
      .toEqual(['resume', '--last'])
  })

  /** A replay is the same command line again, so dropping the prompt would change the first turn. */
  it('replays the prompt with the launch it belongs to', () => {
    const prompt = 'Describe the bug, then fix it'

    expect(AgentPresets.replayArgs({
      agentId: 'claude', launchMode: 'new', nativeSessionId: mintedConst, initialPrompt: prompt,
    })).toEqual(['--session-id', mintedConst, prompt])
    expect(AgentPresets.replayArgs({ agentId: 'codex', launchMode: 'new', initialPrompt: prompt }))
      .toEqual([prompt])
  })

  /**
   * Print mode goes in FRONT of the mode flags and the prompt stays last, because the flag is what
   * the whole invocation is and after the prompt it would be read as more prompt.
   */
  it('puts print mode first and the prompt last', () => {
    expect(AgentPresets.createArgs(
      { agentId: 'claude', mode: 'fork', forkParentId: parentConst, oneShot: true,
        initialPrompt: 'resolve it' },
      undefined,
    )).toEqual(['-p', '--resume', parentConst, '--fork-session', 'resolve it'])
  })

  it('replays print mode with the launch, so a one-shot run is not repeated interactively', () => {
    expect(AgentPresets.replayArgs({
      agentId: 'claude', launchMode: 'fork', forkParentId: parentConst, oneShot: true,
      initialPrompt: 'resolve it',
    })).toEqual(['-p', '--resume', parentConst, '--fork-session', 'resolve it'])
  })

  /**
   * Codex has no print mode this build can judge, so nothing ever asks it for one. The throw is the
   * backstop for the day somebody wires it up without changing `headlessUnsupported` with it.
   */
  it('knows which agent can be left to exit on its own', () => {
    expect(AgentPresets.headlessUnsupported('claude')).toBe(false)
    expect(AgentPresets.headlessUnsupported('codex')).toBe(true)
    expect(() => AgentPresets.createArgs(
      { agentId: 'codex', mode: 'new', oneShot: true },
      undefined,
    )).toThrow(/no print mode/)
  })

  /**
   * The conversation being reopened has already been asked it. Sending it again would be a second
   * first turn landing on top of whatever the answer was.
   */
  it('never repeats the prompt on a reopen', () => {
    expect(AgentPresets.reopenArgs({
      agentId: 'claude', launchMode: 'new', nativeSessionId: mintedConst, initialPrompt: 'anything',
    })).toEqual(['--resume', mintedConst])
  })

  it('maps the other three claude modes', () => {
    expect(AgentPresets.createArgs(claude({ mode: 'continue' }), undefined)).toEqual(['--continue'])
    expect(AgentPresets.createArgs(claude({ mode: 'resume', nativeSessionId: mintedConst }), undefined))
      .toEqual(['--resume', mintedConst])
    expect(AgentPresets.createArgs(claude({ mode: 'fork', forkParentId: parentConst }), undefined))
      .toEqual(['--resume', parentConst, '--fork-session'])
  })

  // A fork starts a conversation that does not exist yet, so it takes a minted id exactly as `new`
  // does. Probed 2026-09-06 on Claude Code 2.1.263: the fork keeps the parent's history and its
  // transcript lands under the given id.
  it('mints a claude fork its own id and appends it behind the resume flags', () => {
    expect(AgentPresets.mintsNativeSessionId(claude({ mode: 'fork', forkParentId: parentConst })))
      .toBe(true)
    expect(AgentPresets.createArgs(claude({ mode: 'fork', forkParentId: parentConst }), mintedConst))
      .toEqual(['--resume', parentConst, '--fork-session', '--session-id', mintedConst])
  })

  // Codex turned out to resume and fork BY ID; the plan expected continue-latest only.
  it('resumes and forks codex by id, and only falls back to --last', () => {
    expect(AgentPresets.createArgs(codex({ mode: 'new' }), mintedConst)).toEqual([])
    expect(AgentPresets.createArgs(codex({ mode: 'continue' }), undefined)).toEqual(['resume', '--last'])
    expect(AgentPresets.createArgs(codex({ mode: 'resume', nativeSessionId: mintedConst }), undefined))
      .toEqual(['resume', mintedConst])
    expect(AgentPresets.createArgs(codex({ mode: 'fork', forkParentId: parentConst }), mintedConst))
      .toEqual(['fork', parentConst])
    expect(AgentPresets.mintsNativeSessionId(codex({ mode: 'new' }))).toBe(false)
    // Codex has no `--session-id` on any subcommand, so a fork of its is named afterwards or not at all.
    expect(AgentPresets.mintsNativeSessionId(codex({ mode: 'fork', forkParentId: parentConst })))
      .toBe(false)
  })

  it('degrades an id-less resume or fork instead of asking for one', () => {
    expect(AgentPresets.createArgs(claude({ mode: 'resume' }), undefined)).toEqual(['--continue'])
    expect(AgentPresets.createArgs(claude({ mode: 'fork' }), undefined))
      .toEqual(['--continue', '--fork-session'])
    expect(AgentPresets.createArgs(codex({ mode: 'resume' }), undefined)).toEqual(['resume', '--last'])
    expect(AgentPresets.createArgs(codex({ mode: 'fork' }), undefined)).toEqual(['fork', '--last'])
  })

  // The session runs in a PTY with nobody at the keyboard: an interactive picker would hold it there.
  it('never emits a codex subcommand without an argument, which is what opens the picker', () => {
    const modes: SessionAgentSpec['mode'][] = ['new', 'continue', 'resume', 'fork']
    for (const mode of modes)
      for (const agent of [
        codex({ mode }),
        codex({ mode, nativeSessionId: mintedConst, forkParentId: parentConst }),
      ]) {
        const args = AgentPresets.createArgs(agent, mintedConst)
        if (args.length > 0) expect(args.length).toBeGreaterThan(1)
      }
  })

  // Every reopen either agent gets is a resume by id; a record that kept none is refused, not guessed.
  it('reopens by the id the record kept, for both agents', () => {
    expect(AgentPresets.reopenArgs({
      agentId: 'claude', launchMode: 'resume', nativeSessionId: mintedConst,
    })).toEqual(['--resume', mintedConst])
    expect(AgentPresets.reopenArgs({
      agentId: 'codex', launchMode: 'resume', nativeSessionId: mintedConst,
    })).toEqual(['resume', mintedConst])
  })

  // The conversation exists by now, under the id the create minted, so reopening resumes it.
  it('reopens a session started as new by resuming the id it was started with', () => {
    expect(AgentPresets.reopenArgs({
      agentId: 'claude', launchMode: 'new', nativeSessionId: mintedConst,
    })).toEqual(['--resume', mintedConst])
  })

  /*
   * `--continue` is directory-scoped, and a directory is not an identity. Two Claude sessions in one
   * project share it - two `continue` launches, two forks, or any mix - so reopening the first would
   * land it on whichever of them ran last, silently, with its own record, cwd, title and worktree
   * all still looking right. That is the harm the Codex refusal was written for, one scope level
   * down, so it earns the same refusal. What is refused is a record that cannot name itself, whatever
   * its launch mode: a `continue`, and a fork taken before forks were minted an id of their own.
   */
  it('refuses to reopen a claude session that has no conversation id of its own', () => {
    const unnameable: SessionRecordAgent[] = [
      { agentId: 'claude', launchMode: 'continue' },
      { agentId: 'claude', launchMode: 'fork', forkParentId: parentConst },
      { agentId: 'claude', launchMode: 'new' },
    ]
    for (const agent of unnameable) {
      expect(AgentPresets.reopenProblem(agent)).toMatch(/newest conversation in this directory/)
      expect(() => AgentPresets.reopenArgs(agent)).toThrow(/Refusing to build a reopen launch/)
    }
    // The ordinary case is untouched: a session created as `new` runs under an id this client minted.
    expect(AgentPresets.reopenProblem({
      agentId: 'claude', launchMode: 'new', nativeSessionId: mintedConst,
    })).toBeNull()
  })

  /*
   * A fork that carries an id carries its OWN, so a reopen resumes the fork rather than either side
   * of it: `reopenArgs` drops `forkParentId` on purpose, and reopening must not fork again.
   */
  it('reopens a fork by the fork\'s own id, for both agents', () => {
    const claudeFork: SessionRecordAgent = {
      agentId: 'claude', launchMode: 'fork', forkParentId: parentConst, nativeSessionId: mintedConst,
    }
    const codexFork: SessionRecordAgent = {
      agentId: 'codex', launchMode: 'fork', forkParentId: parentConst, nativeSessionId: mintedConst,
    }
    expect(AgentPresets.reopenProblem(claudeFork)).toBeNull()
    expect(AgentPresets.reopenArgs(claudeFork)).toEqual(['--resume', mintedConst])
    expect(AgentPresets.reopenProblem(codexFork)).toBeNull()
    expect(AgentPresets.reopenArgs(codexFork)).toEqual(['resume', mintedConst])
  })

  /*
   * Codex has no directory-scoped continue: `resume --last` is the most recent session on the whole
   * machine, and with several agent sessions running here that is usually another project's. Codex
   * also never reports the id it chose, so a record started without one can name no conversation at
   * all - and a reopen that cannot name its conversation is refused rather than landing on somebody
   * else's. The price is that such a Codex session can only be removed and started again.
   */
  it('refuses to reopen a codex session that cannot name its conversation', () => {
    const unnameable: SessionRecordAgent[] = [
      { agentId: 'codex', launchMode: 'new' },
      { agentId: 'codex', launchMode: 'continue' },
      { agentId: 'codex', launchMode: 'resume' },
      // A fork Codex never named. Its own id exists, in the rollout it wrote, but until a capture
      // pass finds it the record can name nothing, and `forkParentId` names the other side of the fork.
      { agentId: 'codex', launchMode: 'fork', forkParentId: parentConst },
    ]
    for (const agent of unnameable) {
      expect(AgentPresets.reopenProblem(agent)).toMatch(/unrelated one/)
      expect(() => AgentPresets.reopenArgs(agent)).toThrow(/Refusing to build a reopen launch/)
    }
    expect(AgentPresets.reopenProblem({
      agentId: 'codex', launchMode: 'resume', nativeSessionId: mintedConst,
    })).toBeNull()
  })

  // A create that never ran has no conversation to resume: what it replays is the create it was.
  it('replays a create in the shape the create had, not in the reopen shape', () => {
    expect(AgentPresets.replayArgs({
      agentId: 'claude', launchMode: 'new', nativeSessionId: mintedConst,
    })).toEqual(['--session-id', mintedConst])
    expect(AgentPresets.replayArgs({
      agentId: 'claude', launchMode: 'resume', nativeSessionId: mintedConst,
    })).toEqual(['--resume', mintedConst])
    expect(AgentPresets.replayArgs({
      agentId: 'claude', launchMode: 'fork', forkParentId: parentConst,
    })).toEqual(['--resume', parentConst, '--fork-session'])
    // A replay repeats the id the create was given, so the retry lands on the same conversation.
    expect(AgentPresets.replayArgs({
      agentId: 'claude', launchMode: 'fork', forkParentId: parentConst, nativeSessionId: mintedConst,
    })).toEqual(['--resume', parentConst, '--fork-session', '--session-id', mintedConst])
    expect(AgentPresets.replayArgs({ agentId: 'codex', launchMode: 'new' })).toEqual([])
    expect(AgentPresets.replayArgs({
      agentId: 'codex', launchMode: 'fork', forkParentId: parentConst,
    })).toEqual(['fork', parentConst])
  })

  it('throws on an agent or a mode it does not know', () => {
    expect(() => AgentPresets.createArgs(
      { agentId: 'gemini' as SessionAgentSpec['agentId'], mode: 'new' }, undefined,
    )).toThrow(/Unknown agent/)
    expect(() => AgentPresets.createArgs(
      claude({ mode: 'branch' as SessionAgentSpec['mode'] }), undefined,
    )).toThrow(/Unknown claude launch mode/)
    expect(() => AgentPresets.createArgs(
      codex({ mode: 'branch' as SessionAgentSpec['mode'] }), undefined,
    )).toThrow(/Unknown codex launch mode/)
    expect(() => AgentPresets.reopenArgs({
      agentId: 'claude',
      launchMode: 'branch' as SessionAgentSpec['mode'],
    })).toThrow(/Unknown launch mode/)
  })
})
