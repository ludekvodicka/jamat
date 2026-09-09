import { describe, expect, it } from 'vitest'

import type {
  SessionActivity,
  SessionInfo,
  SessionSetupInfo,
} from '../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { type SessionAction, type SessionGlyph, SessionNodeState } from './sessionNodeState'

describe('app-client-ui/renderer/views/sessionsTree/sessionNodeState', () => {
  type Life = SessionInfo['life']
  type Kind = SessionInfo['kind']
  type Detail = SessionInfo['activityDetail']

  /** Every combination the wire can carry, and the one shape each is drawn as. */
  const glyphTable: readonly [Life, Kind, SessionActivity | null, Detail, SessionGlyph][] = [
    ['starting', 'agent', 'unknown', undefined, 'starting'],
    ['starting', 'agent', 'working', undefined, 'starting'],
    ['starting', 'shell', null, undefined, 'starting'],
    ['ended', 'agent', 'idle', undefined, 'ended'],
    ['ended', 'shell', null, undefined, 'ended'],
    ['lost', 'agent', 'unknown', undefined, 'lost'],
    ['lost', 'shell', null, undefined, 'lost'],
    ['live', 'shell', null, undefined, 'shell'],
    ['live', 'shell', 'working', undefined, 'shell'],
    ['live', 'agent', 'working', undefined, 'working'],
    ['live', 'agent', 'working', 'background', 'background'],
    ['live', 'agent', 'waiting', undefined, 'waiting'],
    ['live', 'agent', 'idle', undefined, 'idle'],
    ['live', 'agent', 'unknown', undefined, 'unknown'],
    ['live', 'agent', null, undefined, 'unknown'],
  ]

  it('draws every life, kind and activity the wire can carry', () => {
    const drawn = glyphTable.map(([life, kind, activity, detail]) =>
      SessionNodeState.glyphOf(life, kind, activity, detail))

    expect(drawn).toEqual(glyphTable.map(([, , , , glyph]) => glyph))
  })

  it('throws on a life, a kind or an activity it does not know', () => {
    expect(() => SessionNodeState.glyphOf('zombie' as Life, 'agent', 'idle'))
      .toThrow('Unknown session life: "zombie"')
    expect(() => SessionNodeState.glyphOf('live', 'daemon' as Kind, 'idle'))
      .toThrow('Unknown session kind: "daemon"')
    expect(() => SessionNodeState.glyphOf('live', 'agent', 'napping' as SessionActivity))
      .toThrow('Unknown session activity: "napping"')
    expect(() => SessionNodeState.glyphOf('live', 'agent', 'idle', 'background'))
      .toThrow('Background activity detail requires working activity: "idle"')
  })

  /** One character per state, for the row and the tab alike: a state with none is a state undrawn. */
  it('spells every glyph it can produce', () => {
    const spelled = glyphTable.map(([, , , , glyph]) => SessionNodeState.characterOf(glyph, false))

    expect(new Set(spelled).size).toBe(new Set(glyphTable.map(([, , , , g]) => g)).size)
    expect(SessionNodeState.characterOf('working', false)).toBe('●')
    expect(SessionNodeState.characterOf('background', false)).toBe('◉')
    expect(SessionNodeState.characterOf('waiting', false)).toBe('◆')
    expect(() => SessionNodeState.characterOf('napping' as SessionGlyph, false))
      .toThrow('Unknown session glyph: "napping"')
  })

  it('fills unseen idle squares and distinguishes them from running by shape and tone', () => {
    expect(SessionNodeState.characterOf('idle', true)).toBe('■')
    expect(SessionNodeState.characterOf('idle', false)).toBe('□')
    expect(SessionNodeState.characterOf('idle', true)).not.toBe(SessionNodeState.characterOf('working', true))
    expect(SessionNodeState.paintOf('idle', true)).toBe('idle')
    expect(SessionNodeState.paintOf('working', true)).toBe('ok')
  })

  it('offers finish while there is a step left, and rerun or remove once there is none', () => {
    expect(SessionNodeState.actionsOf({ life: 'live', admits: ['finalize'] }, false))
      .toEqual(['finalize'])
    expect(SessionNodeState.actionsOf({ life: 'starting', admits: ['finalize'] }, false))
      .toEqual(['finalize'])
    // A live session is never removable, and the library says so; the row does not decide it twice.
    expect(SessionNodeState.actionsOf({ life: 'live', admits: ['finalize', 'compact'] }, false))
      .toEqual(['finalize'])
    expect(SessionNodeState.actionsOf({ life: 'ended', admits: ['restart', 'remove'] }, false))
      .toEqual(['reopen', 'remove'])
    expect(SessionNodeState.actionsOf({ life: 'lost', admits: ['restart', 'remove'] }, false))
      .toEqual(['reopen', 'remove'])
    expect(() => SessionNodeState.actionsOf({ life: 'zombie' as Life, admits: [] }, false))
      .toThrow('Unknown session life: "zombie"')
  })

  /**
   * The row asks the library rather than deciding for itself, and this is the case that proves it
   * had to: `admits` carries no `restart` for a fork, for a Codex session whose conversation was
   * never named, and for a record another flow is holding. The row drew Rerun for all three and
   * every press answered `cannot be reopened` - a button whose only answer is a refusal, which the
   * rule beside Discard already forbade.
   */
  it('offers no rerun where the library would refuse the reopen', () => {
    const worktree = {
      worktreePath: 'Q:/p/.worktrees/015',
      branch: 'jamat/015',
      baseCommit: 'abc',
      diff: null,
      baseMoved: false,
      dirty: false,
    }

    expect(SessionNodeState.actionsOf({ life: 'ended', admits: ['remove'] }, false))
      .toEqual(['remove'])
    expect(SessionNodeState.actionsOf({
      life: 'lost', admits: ['fork', 'newBeside', 'remove'],
    }, false))
      .toEqual(['remove'])
    expect(SessionNodeState.actionsOf({
      life: 'ended',
      admits: ['finalize', 'discardWorktree', 'remove'],
    }, true)).toEqual(['finalize', 'remove'])
    expect(worktree.baseMoved).toBe(false)
  })

  /**
   * The row a launch nobody accepted leaves behind. The library admits `remove` for it and no
   * `finalize`, because there is no runtime to stop - and the row that filtered `remove` out of
   * every running session is what left it with Finish as its only button, whose one possible answer
   * was `has no runtime on the Host yet`. Neither started nor closable, on a screen, for as long as
   * the Host kept refusing.
   */
  it('offers remove on a starting session the Host never took', () => {
    expect(SessionNodeState.actionsOf({ life: 'starting', admits: ['newBeside', 'remove'] }, false))
      .toEqual(['remove'])
  })

  /**
   * The second sentence beside the glyph, and only once the library says the wait is worth one:
   * below its threshold the row says `starting`, which is what a launch going through looks like.
   */
  it('says a launch is waiting only where the library reports one', () => {
    expect(SessionNodeState.launchBadgeOf(undefined)).toBeNull()
    expect(SessionNodeState.launchTitleOf(undefined)).toBeNull()
    expect(SessionNodeState.launchBadgeOf({ reason: 'the limit', attempts: 7 })).toBe('waiting')
    expect(SessionNodeState.launchTitleOf({ reason: 'the limit', attempts: 7 }))
      .toBe('The launch has not been accepted yet after 7 attempts: the limit')
  })

  it('names the stop plainly and promises a dialog after the session ended', () => {
    expect(SessionNodeState.finalizeLabelOf('live')).toBe('Finish')
    expect(SessionNodeState.finalizeLabelOf('starting')).toBe('Finish')
    expect(SessionNodeState.finalizeLabelOf('ended')).toBe('Finish…')
    expect(SessionNodeState.finalizeLabelOf('lost')).toBe('Finish…')
    expect(() => SessionNodeState.finalizeLabelOf('zombie' as Life))
      .toThrow('Unknown session life: "zombie"')
  })

  it('uses one label for each action across the row and its menu', () => {
    const actions: readonly SessionAction[] = ['finalize', 'retrySetup', 'reopen', 'remove']
    expect(actions.map((action) => SessionNodeState.actionLabelOf(action)))
      .toEqual(['Finish', 'Retry setup', 'Rerun', 'Remove'])
    expect(() => SessionNodeState.actionLabelOf('discardWorktree' as SessionAction))
      .toThrow('Unknown session action: "discardWorktree"')
  })

  it('offers the catalog entry on a finished session and never row-level discard', () => {
    const worktree = {
      worktreePath: 'Q:/p/.worktrees/015',
      branch: 'jamat/015',
      baseCommit: 'abc',
      diff: null,
      baseMoved: false,
      dirty: false,
    }

    const ended = ['finalize', 'discardWorktree', 'restart', 'remove'] as const
    expect(SessionNodeState.actionsOf({ life: 'ended', admits: ended }, true))
      .toEqual(['finalize', 'reopen', 'remove'])
    expect(SessionNodeState.actionsOf({ life: 'lost', admits: ended }, true))
      .toEqual(['finalize', 'reopen', 'remove'])
    expect(SessionNodeState.actionsOf({ life: 'live', admits: ['finalize'] }, true))
      .toEqual(['finalize'])
    expect(worktree.branch).toBe('jamat/015')
  })

  /**
   * The agent never ran there, so the only uncommitted thing in that worktree is what the half-run
   * install left. Committing a partial lockfile and merging it into the base branch is not what
   * "finish with this session" means.
   */
  it('offers the catalog dialog on a failed install even without admitted finalize', () => {
    const worktree = {
      worktreePath: 'Q:/p/.worktrees/015',
      branch: 'jamat/015',
      baseCommit: 'abc',
      diff: null,
      baseMoved: false,
      dirty: true,
    }
    // What the library admits for that record: no `finalize`, because there is nothing to bring
    // home from a worktree whose install never finished.
    expect(SessionNodeState.actionsOf({
      life: 'ended',
      admits: ['discardWorktree', 'retrySetup', 'restart', 'remove'],
    }, true)).toEqual(['finalize', 'retrySetup', 'reopen', 'remove'])
    expect(SessionNodeState.actionsOf({
      life: 'ended',
      admits: ['discardWorktree', 'retrySetup', 'restart', 'remove'],
    }, false)).toEqual(['retrySetup', 'reopen', 'remove'])
    expect(worktree.dirty).toBe(true)
  })

  it('offers the retry only where the library admitted one', () => {
    expect(SessionNodeState.actionsOf({
      life: 'ended',
      admits: ['retrySetup', 'restart', 'remove'],
    }, false)).toEqual(['retrySetup', 'reopen', 'remove'])
    expect(SessionNodeState.actionsOf({ life: 'ended', admits: ['restart', 'remove'] }, false))
      .toEqual(['reopen', 'remove'])
  })

  it('draws nothing the library did not admit', () => {
    expect(SessionNodeState.actionsOf({ life: 'ended', admits: ['finalize', 'remove'] }, true))
      .toEqual(['finalize', 'remove'])
    expect(SessionNodeState.actionsOf({ life: 'ended', admits: [] }, false)).toEqual([])
    // And nothing of its own: an operation this row has no action for is simply not drawn.
    expect(SessionNodeState.actionsOf({ life: 'live', admits: ['fork', 'compact'] }, true))
      .toEqual([])
  })

  /** A failure outranks the phase: what the row has to say is that the merge stopped. */
  it('reads the merge badge from the phase, with a failure winning over it', () => {
    expect(SessionNodeState.mergeBadgeOf(undefined)).toBeNull()
    for (const phase of ['base-merging', 'main-merging', 'tearing-down'] as const)
      expect(SessionNodeState.mergeBadgeOf({ phase, startedAt: 0 })).toBe('merging')
    expect(SessionNodeState.mergeBadgeOf({ phase: 'resolving', startedAt: 0 })).toBe('conflict')
    expect(SessionNodeState.mergeBadgeOf({ phase: 'resolving', failure: 'boom', startedAt: 0 }))
      .toBe('merge-failed')
    expect(SessionNodeState.mergeBadgeOf({ phase: 'base-merging', failure: 'boom', startedAt: 0 }))
      .toBe('merge-failed')
    expect(() => SessionNodeState.mergeBadgeOf({
      phase: 'gluing' as 'resolving',
      startedAt: 0,
    })).toThrow('Unknown merge phase: "gluing"')
  })

  it('counts a starting session as live and an ended one as not', () => {
    expect(SessionNodeState.isLive('live')).toBe(true)
    expect(SessionNodeState.isLive('starting')).toBe(true)
    expect(SessionNodeState.isLive('ended')).toBe(false)
    expect(SessionNodeState.isLive('lost')).toBe(false)
    expect(() => SessionNodeState.isLive('zombie' as Life))
      .toThrow('Unknown session life: "zombie"')
  })

  it('names what an install did, and nothing when there was no install', () => {
    expect(SessionNodeState.setupBadgeOf(undefined)).toBe(null)
    expect(SessionNodeState.setupBadgeOf({ state: 'running', setupSessionId: 's-1', commands: [] }))
      .toBe('installing')
    expect(SessionNodeState.setupBadgeOf({ state: 'failed', setupSessionId: 's-1', commands: [] }))
      .toBe('install-failed')
    expect(SessionNodeState.setupBadgeOf({ state: 'skipped', reason: 'nothing to run' }))
      .toBe('install-skipped')
    expect(() => SessionNodeState.setupBadgeOf({ state: 'queued' } as unknown as SessionSetupInfo))
      .toThrow('Unknown session setup state')
  })

  /* An install runs with echo off, so until a terminal exists this tooltip is the only place the
     commands can be read - which is what makes an agreed-to setup auditable after it started. */
  it('puts the commands behind the badge, and the reason when nothing ran', () => {
    expect(SessionNodeState.setupTitleOf(undefined)).toBe(null)
    expect(SessionNodeState.setupTitleOf({
      state: 'running',
      setupSessionId: 's-1',
      commands: ['./bootstrap.sh', 'pnpm install'],
    })).toBe('./bootstrap.sh\npnpm install')
    expect(SessionNodeState.setupTitleOf({ state: 'skipped', reason: 'nothing to run' }))
      .toBe('Nothing was installed: nothing to run')
    // A record written before the commands were on the wire has nothing to say, and says nothing.
    expect(SessionNodeState.setupTitleOf({ state: 'failed', setupSessionId: 's-1', commands: [] }))
      .toBe(null)
    expect(() => SessionNodeState.setupTitleOf({ state: 'queued' } as unknown as SessionSetupInfo))
      .toThrow('Unknown session setup state')
  })

  /**
   * The ladder, read top down. It is one derivation because both surfaces draw from it, and it is
   * exhaustive because a glyph nobody handled must fail loudly rather than come out muted.
   */
  it('paints the most urgent thing true of a session, marked or not', () => {
    const table: readonly [SessionGlyph, boolean, string][] = [
      ['lost', false, 'danger'],
      ['lost', true, 'danger'],
      ['waiting', false, 'attention'],
      ['waiting', true, 'attention'],
      ['idle', false, 'idle'],
      ['idle', true, 'idle'],
      ['ended', false, 'muted'],
      ['ended', true, 'accent'],
      ['working', false, 'ok'],
      ['working', true, 'ok'],
      ['background', false, 'ok'],
      ['background', true, 'ok'],
      ['starting', false, 'accent'],
      ['shell', true, 'muted'],
      ['unknown', true, 'muted'],
    ]

    for (const [glyph, marked, paint] of table)
      expect(`${glyph}/${marked}: ${SessionNodeState.paintOf(glyph, marked)}`)
        .toBe(`${glyph}/${marked}: ${paint}`)
  })

  /**
   * A session that settled and then started working again is working, whatever nobody has read yet.
   * Letting the mark win would erase the green from the tree, so the colour keeps saying what the
   * session is DOING and the tooltip carries the rest.
   */
  it('keeps a working session green while still admitting nobody has looked', () => {
    expect(SessionNodeState.paintOf('working', true)).toBe('ok')
    expect(SessionNodeState.glyphTitleOf('working', true))
      .toBe('working - not seen since the turn finished')
    expect(SessionNodeState.glyphTitleOf('working', false)).toBe('working')
    expect(SessionNodeState.glyphTitleOf('background', false)).toBe('background work')
    expect(SessionNodeState.glyphTitleOf('background', true))
      .toBe('background work - previous result not seen')
  })

  it('says which kind of unseen it is, because an ending is not a finished turn', () => {
    expect(SessionNodeState.glyphTitleOf('ended', true)).toBe('ended - not seen since it ended')
    expect(SessionNodeState.glyphTitleOf('lost', true)).toBe('lost - not seen since it was lost')
    expect(SessionNodeState.glyphTitleOf('idle', true))
      .toBe('idle - not seen since the turn finished')
  })

  it('throws on a glyph the ladder does not handle', () => {
    expect(() => SessionNodeState.paintOf('nonsense' as SessionGlyph, false))
      .toThrow('Unknown session glyph')
  })

  /** The word alone cannot say what is happening to the worktree, nor why a merge stopped. */
  it('carries the merge reason into the merge word', () => {
    expect(SessionNodeState.mergeTitleOf(undefined)).toBeNull()
    expect(SessionNodeState.mergeTitleOf({ phase: 'main-merging', startedAt: 1 }))
      .toBe('Merging the worktree back to its base')
    expect(SessionNodeState.mergeTitleOf({ phase: 'resolving', startedAt: 1 }))
      .toBe('Stopped on conflicts; a resolve session is settling them')
    expect(SessionNodeState.mergeTitleOf({ phase: 'main-merging', startedAt: 1, failure: 'the base moved' }))
      .toBe('the base moved')
  })
})
