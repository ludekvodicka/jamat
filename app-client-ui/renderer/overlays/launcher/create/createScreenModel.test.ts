import { describe, expect, it } from 'vitest'

import type {
  SessionCreateSpec,
} from '../../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type {
  RemoteControlAgentDto,
} from '../../../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type { LauncherBinding } from '../launcherBinding'
import type { LauncherTarget } from '../launcherTarget'
import type {
  CreateSessionTarget,
  CreateScreenInput,
  CreateScreenState,
  CreateScreenStep,
  ExistingSessionSummary,
  RemoteExistingSession,
} from './createScreenModel'
import { CreateScreenModel } from './createScreenModel'

describe('app-client-ui/renderer/overlays/launcher/create/createScreenModel', () => {
  /** The three profiles the type list is asked about, spelled once. */
  const CreateProfilesConst: Readonly<
    Record<
      'local' | 'tab' | 'remote',
      { tabProfile: boolean; target: LauncherTarget; source: CreateSessionTarget | null }
    >
  > = {
    local: { tabProfile: false, target: { kind: 'local' }, source: null },
    tab: { tabProfile: true, target: { kind: 'local' }, source: null },
    remote: {
      tabProfile: false,
      target: { kind: 'remote', remoteEndpointId: 'endpoint-a', displayName: 'Studio' },
      source: null,
    },
  }
  const remoteTargetConst = CreateProfilesConst.remote.target
  /**
   * What the TARGET answers about itself. Codex is configured to an id its own catalog no longer
   * lists, which is the case the picker has to draw as a bare extra entry rather than hide.
   */
  const describedAgentsConst: readonly RemoteControlAgentDto[] = [
    {
      agentId: 'claude',
      configuredModel: 'opus',
      models: [
        { id: 'opus', label: 'Opus (newest)', kind: 'alias', context: 200_000, efforts: ['high'],
          note: 'always the newest Opus' },
        { id: 'claude-fable-5', label: 'Claude Fable 5', kind: 'version', context: 200_000,
          efforts: ['high'] },
      ],
    },
    {
      agentId: 'codex',
      configuredModel: 'gpt-5.4-retired',
      models: [
        { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', kind: 'version', context: 272_000,
          efforts: ['high'] },
      ],
    },
  ]
  /** Whatever the uncertain attempt sent; only its identity matters to these tests. */
  const sentSpecConst: SessionCreateSpec = { kind: 'shell', directory: { mode: 'default' } }
  const remoteSessionsConst: readonly RemoteExistingSession[] = [
    {
      sessionId: 'remote-1',
      tabTitle: 'AppJamatV3 - 007',
      title: '007 - the wire',
      agentId: 'claude',
      running: false,
    },
    {
      sessionId: 'remote-2',
      tabTitle: 'AppJamatV3 - 008',
      title: '008 - the listener',
      agentId: 'codex',
      running: true,
    },
  ]
  const projectConst: LauncherBinding = {
    mode: 'project',
    categoryId: 'nodejs',
    projectName: 'AppJamatV3',
    projectPath: 'C:\\Projects\\NodeJs\\AppJamatV3',
  }

  /** The project a peeked number is FOR: one read for another project is dropped. */
  const projectPathConst = projectConst.mode === 'project'
    ? projectConst.projectPath
    : ''
  /**
   * The session a card was opened on: its id, its conversation, its own number and its name. The
   * conversation is the first of the project's own listing below on purpose - that is the case the
   * list has to draw once rather than twice.
   */
  const forkConst: CreateSessionTarget = {
    mode: 'fork',
    sessionId: 's-parent',
    agentId: 'claude',
    nativeSessionId: 'claude-1',
    number: '014',
    title: '014 - the wire',
    tabTitle: 'AppJamatV3 - the wire',
  }
  /** The same session as the OTHER card opens it: ended, and brought back rather than branched. */
  const resumeConst: CreateSessionTarget = { ...forkConst, mode: 'resume' }
  const existingConst: readonly ExistingSessionSummary[] = [
    {
      agentId: 'claude',
      nativeSessionId: 'claude-1',
      title: 'Claude work',
      firstUserMessage: 'first',
      createdAt: 1,
      lastActivity: 3,
      active: true,
      localTitle: '014 - Claude work',
    },
    {
      agentId: 'codex',
      nativeSessionId: 'codex-1',
      title: 'Codex work',
      firstUserMessage: 'second',
      createdAt: 1,
      lastActivity: 2,
      active: false,
      localTitle: null,
    },
  ]

  /*
   * A peek is one round trip, and a card left and reopened elsewhere has two in flight. The older
   * answer used to be drawn beside the new project's name and to feed the branch preview, so the
   * slug named another project's count.
   */
  /*
   * The success path of a submit calls `openTerminal` and `close` whatever screen is up, so backing
   * out of a slow create - a worktree plus an install, with nothing apparently happening - opened a
   * tab for a session the person believed they had cancelled, and a second Enter in that window made
   * it two sessions with two numbers. The footer already says "Starting…".
   */
  it('cannot be escaped while a submit is out', () => {
    const submitting = Run.numbered().on({ input: 'activate' })
    expect(submitting.step.state.submitting).toBe(true)

    const escaped = submitting.on({ input: 'escape' })

    expect(escaped.step.effects).toEqual([])
    expect(escaped.step.state.submitting).toBe(true)
  })

  it('is escaped as before while nothing is out', () => {
    expect(Run.numbered().on({ input: 'escape' }).step.effects).toEqual([{ effect: 'back' }])
  })

  describe('a number that arrives for a project the card has left', () => {
    it('is dropped rather than drawn', () => {
      const opened = CreateScreenModel.opened(projectConst)
      const foreign = CreateScreenModel.transition(opened.state, {
        input: 'numberLoaded',
        projectPath: 'C:\\Projects\\NodeJs\\SomethingElse',
        token: '042',
      })

      expect(foreign.state.token).toBeNull()
    })

    it('takes the one that IS for this project', () => {
      const opened = CreateScreenModel.opened(projectConst)
      const mine = CreateScreenModel.transition(opened.state, {
        input: 'numberLoaded',
        projectPath: projectPathConst,
        token: '042',
      })

      expect(mine.state.token).toBe('042')
    })

    // A directory binding counts nothing, so a number answering for one is not this card's either.
    it('is dropped where the card is bound to a directory rather than a project', () => {
      const opened = CreateScreenModel.opened({ mode: 'adHoc', path: 'Q:\\somewhere' })
      const answered = CreateScreenModel.transition(opened.state, {
        input: 'numberLoaded',
        projectPath: 'Q:\\somewhere',
        token: '042',
      })

      expect(answered.state.token).toBeNull()
    })
  })

  class Run {
    private constructor(public step: CreateScreenStep) {}

    static opened(binding: LauncherBinding = projectConst): Run {
      return new Run(CreateScreenModel.opened(binding))
    }

    static tabProfile(binding: LauncherBinding = projectConst): Run {
      return new Run(CreateScreenModel.opened(binding, { tabProfile: true }))
    }

    static remote(binding: LauncherBinding = projectConst): Run {
      return new Run(CreateScreenModel.opened(binding, { target: remoteTargetConst }))
    }

    /** The remote card with the target's answer already in: the state a model can travel from. */
    static described(agents: readonly RemoteControlAgentDto[] = describedAgentsConst): Run {
      return Run.remote().on({
        input: 'agentsDescribed',
        remoteEndpointId: 'endpoint-a',
        agents,
      })
    }

    /** The last type row is Shell, and `chooseType` clamps, so any number past the end lands on it. */
    static shell(binding: LauncherBinding = projectConst): Run {
      return Run.opened(binding).on({ input: 'chooseType', index: 99 })
    }

    /** The ordinary starting point: the card is up and the peeked number has arrived. */
    static numbered(token = '015'): Run {
      return Run.opened().on({ input: 'numberLoaded', projectPath: projectPathConst, token })
    }

    /** The card as `session.fork` opens it: on the parent's own name, with its number peeked. */
    static forking(token: string | null = '015'): Run {
      return Run.acting(forkConst, token)
    }

    /** The same card once the project's own conversations have been read in beside its row. */
    static forkingListed(): Run {
      return Run.forking().on({
        input: 'existingSessionsLoaded',
        categoryId: 'nodejs',
        projectName: 'AppJamatV3',
        summaries: existingConst,
      })
    }

    /** A card opened on a session somewhere that has no project list to read at all. */
    static actingIn(binding: LauncherBinding, source: CreateSessionTarget): Run {
      return new Run(CreateScreenModel.opened(binding, { source }))
    }

    /** The card as `session.resume` opens it: the same session, brought back rather than branched. */
    static resuming(token: string | null = '015'): Run {
      return Run.acting(resumeConst, token)
    }

    private static acting(source: CreateSessionTarget, token: string | null): Run {
      const opened = new Run(CreateScreenModel.opened(projectConst, {
        name: 'the wire',
        agentId: 'claude',
        source,
      }))
      return token === null
        ? opened
        : opened.on({ input: 'numberLoaded', projectPath: projectPathConst, token })
    }

    static existing(summaries = existingConst): Run {
      const index = CreateScreenModel.typesOf(CreateProfilesConst.local).findIndex((type) => type.kind === 'existing')
      return Run.numbered().on(
        { input: 'chooseType', index },
        {
          input: 'existingSessionsLoaded',
          categoryId: 'nodejs',
          projectName: 'AppJamatV3',
          summaries,
        },
      )
    }

    on(...inputs: readonly CreateScreenInput[]): Run {
      let step = this.step
      for (const input of inputs)
        step = CreateScreenModel.transition(step.state, input)
      return new Run(step)
    }

    get state(): CreateScreenState {
      return this.step.state
    }

    get effects(): CreateScreenStep['effects'] {
      return this.step.effects
    }
  }

  it('peeks the number for a catalog project and asks for nothing anywhere else', () => {
    expect(Run.opened().effects)
      .toEqual([{ effect: 'fetchNumber', projectPath: 'C:\\Projects\\NodeJs\\AppJamatV3' }])
    expect(Run.opened({ mode: 'adHoc', path: 'D:\\work' }).effects).toEqual([])
  })

  // The opener asks for no type at all: which row a session starts on is the create screen's own
  // question, and Raw is the answer it opens with wherever it was opened from.
  it('starts on Raw', () => {
    expect(CreateScreenModel.typeOf(Run.opened().state).kind).toBe('raw')
  })

  /**
   * The card `Fork session` opens: Continue/Fork, standing on the session it was opened on.
   *
   * That session is a ROW of that list rather than a type beside it. The list's own words are
   * "resume ended sessions, fork running ones", so a second card next to it saying Fork was one
   * operation drawn twice, and what the command does is answer the question the list asks.
   */
  describe('a card opened on a running session', () => {
    it('opens on Continue/Fork standing on that session, and reads the list around it', () => {
      const run = Run.forking(null)

      expect(CreateScreenModel.typeOf(run.state).kind).toBe('existing')
      expect(CreateScreenModel.actingOn(run.state)).toEqual(forkConst)
      expect(run.state.name).toBe('the wire')
      expect(run.effects).toEqual([
        { effect: 'fetchNumber', projectPath: projectPathConst },
        {
          effect: 'fetchExistingSessions',
          categoryId: 'nodejs',
          projectName: 'AppJamatV3',
          projectPath: projectPathConst,
        },
      ])
    })

    // The number PAIR, which is what the title will carry: the parent keeps the left half and the
    // fork spends its own on the right. `SessionTitle` composes both, here and in the library.
    it('draws the number as the pair the title will carry', () => {
      expect(CreateScreenModel.tokenLabelOf(Run.forking().state)).toBe('014-015')
      expect(CreateScreenModel.tokenLabelOf(Run.forking(null).state)).toBeNull()
      expect(CreateScreenModel.tokenLabelOf(Run.numbered().state)).toBe('015')
    })

    // Continue/Fork leads, and the rest stay: the same card still says "actually, a fresh one in
    // the same place" without being closed and opened again.
    it('leads the type list without taking the others away', () => {
      expect(CreateScreenModel.typesOf(Run.forking().state).map((type) => type.kind))
        .toEqual(['existing', 'raw', 'flow', 'shell'])
      expect(CreateScreenModel.typesOf(CreateProfilesConst.local).map((type) => type.kind))
        .toEqual(['raw', 'flow', 'existing', 'shell'])
    })

    /*
     * One conversation, one row. The session a card is opened on is usually in the project's own
     * listing as well, and drawing it twice would offer the same conversation as two rows that do
     * different things.
     */
    it('leads the list as a row of its own, and never as a second one', () => {
      const rows = CreateScreenModel.existingDisplayRowsOf(Run.forkingListed().state)

      expect(rows.map((row) => row.label)).toEqual(['014 - the wire', 'Codex work'])
      expect(rows[0]?.mark).toBe('this session')
      expect(rows[1]?.mark).toBeNull()
    })

    // The filter picks which of the project's conversations to look through, and this row is not
    // one of them: it is what the card is about.
    it('keeps its own row through the agent filter', () => {
      const filtered = Run.forkingListed().on({ input: 'chooseExistingAgent', agentId: 'codex' })

      expect(CreateScreenModel.existingDisplayRowsOf(filtered.state).map((row) => row.label))
        .toEqual(['014 - the wire', 'Codex work'])
      expect(CreateScreenModel.actingOn(filtered.state)).toEqual(forkConst)
    })

    /*
     * A fork founds a session that is still to be called something, so this is the one row of that
     * list which asks for a name. Its directory is not asked at all: a session opened out of this
     * list runs where it already runs, and the row says so instead of drawing a choice that does
     * nothing.
     */
    it('asks for a name, and says where the isolation was decided', () => {
      const run = Run.forking()

      expect(CreateScreenModel.fieldsOf(run.state))
        .toEqual(['name', 'type', 'agent', 'existingSessions'])
      expect(CreateScreenModel.worktreeRefusal(run.state)).toMatch(/runs in its project/)
      expect(run.on({ input: 'toggleWorktree' }).state.worktree).toBe(false)
    })

    it('submits the session it was opened on and the name that was typed over', () => {
      const run = Run.forking().on({ input: 'nameChanged', name: '  the wire again  ' })

      const activated = run.on({ input: 'activate' })

      expect(activated.effects)
        .toEqual([{ effect: 'forkSession', sessionId: 's-parent', name: 'the wire again' }])
      expect(activated.state.submitting).toBe(true)
    })

    /*
     * Moved onto another conversation, the card is doing what the list does: that conversation is
     * opened by its own id, the pair prefix goes back to an ordinary number, and the name row goes
     * with it - what comes back from there is already named.
     */
    it('lets go of the session as soon as the cursor moves off its row', () => {
      const moved = Run.forkingListed().on({ input: 'setExistingCursor', index: 1 })

      expect(CreateScreenModel.actingOn(moved.state)).toBeNull()
      expect(CreateScreenModel.tokenLabelOf(moved.state)).toBe('015')
      expect(CreateScreenModel.fieldsOf(moved.state)).toEqual(['type', 'agent', 'existingSessions'])
      const effect = moved.on({ input: 'activate' }).effects[0]
      expect(effect?.effect === 'openHistory' && effect.spec.nativeSessionId).toBe('codex-1')
    })
  })

  /**
   * The same row under the other of that list's two words. Over a session that has STOPPED, opening
   * its row brings THAT session back - its number, its name, its colour, its note - so there is
   * nothing to name and the number it draws is its own rather than a pair.
   */
  describe('a card opened on a session that has stopped', () => {
    it('opens standing on its row, with nothing to type', () => {
      const run = Run.resuming()

      expect(CreateScreenModel.typeOf(run.state).kind).toBe('existing')
      expect(CreateScreenModel.actingOn(run.state)).toEqual(resumeConst)
      expect(run.state.field).toBe('existingSessions')
      expect(CreateScreenModel.fieldsOf(run.state)).toEqual(['type', 'agent', 'existingSessions'])
      expect(CreateScreenModel.tokenLabelOf(run.state)).toBe('015')
    })

    // The row draws it as what it is: a session that is not running, where a fork's row carries the
    // dot that says it is.
    it('draws its row as the stopped session it is', () => {
      expect(CreateScreenModel.existingDisplayRowsOf(Run.resuming().state)
        .map((row) => [row.label, row.active]))
        .toEqual([['014 - the wire', false]])
      expect(CreateScreenModel.existingDisplayRowsOf(Run.forking().state)
        .map((row) => row.active))
        .toEqual([true])
    })

    it('submits the session it was opened on, and the name of a tab for it', () => {
      const activated = Run.resuming().on({ input: 'activate' })

      expect(activated.effects).toEqual([{
        effect: 'resumeSession',
        sessionId: 's-parent',
        tabTitle: 'AppJamatV3 - the wire',
      }])
      expect(activated.state.submitting).toBe(true)
    })

    /*
     * A session in a worktree writes its transcript where it runs and an ad-hoc directory has no
     * project list at all, so the row stands on its own: the card acts from it with nothing loaded,
     * and says the list is read rather than drawing `Loading sessions…` under a fetch that is never
     * made.
     */
    it('acts on that session where there is no project list to read', () => {
      const run = Run.actingIn({ mode: 'adHoc', path: 'Q:\\somewhere' }, resumeConst)

      expect(run.effects).toEqual([])
      expect(CreateScreenModel.existingLoaded(run.state)).toBe(true)
      expect(CreateScreenModel.existingRefusal(run.state)).toBeNull()
      expect(CreateScreenModel.typeRefusal(run.state, { kind: 'existing' })).toBeNull()
      expect(CreateScreenModel.existingDisplayRowsOf(run.state).map((row) => row.label))
        .toEqual(['014 - the wire'])
      expect(run.on({ input: 'activate' }).effects).toEqual([{
        effect: 'resumeSession',
        sessionId: 's-parent',
        tabTitle: 'AppJamatV3 - the wire',
      }])
    })

    /*
     * Moved off the list, the card is an ordinary create in that project: an ordinary number, the
     * rows a create asks, and nothing being done to a session any more.
     */
    it('goes back to an ordinary card when another type is chosen', () => {
      const raw = Run.forking().on({ input: 'chooseType', index: 1 })

      expect(CreateScreenModel.typeOf(raw.state).kind).toBe('raw')
      expect(CreateScreenModel.actingOn(raw.state)).toBeNull()
      expect(CreateScreenModel.tokenLabelOf(raw.state)).toBe('015')
      expect(CreateScreenModel.fieldsOf(raw.state)).toEqual(['name', 'type', 'isolation', 'agent'])
    })
  })

  it('seeds only the agent from the remembered choice', () => {
    const state = CreateScreenModel.opened(projectConst, { agentId: 'codex' }).state

    expect(state.agentId).toBe('codex')
    expect(CreateScreenModel.typeOf(state).kind).toBe('raw')
    expect(state.name).toBe('')
    expect(state.worktree).toBe(false)
    expect(state.existingAgentFilter).toBe('all')
    expect(state.field).toBe('name')
  })

  it('orders Continue/Fork after the flow and before Shell', () => {
    expect(CreateScreenModel.typesOf(CreateProfilesConst.local)).toEqual([
      { kind: 'raw' },
      { kind: 'flow', flowId: 'feature-request' },
      { kind: 'existing' },
      { kind: 'shell' },
    ])
  })

  describe('the Continue/Fork type', () => {
    it('loads the project history lazily and defaults its agent filter to All', () => {
      const index = CreateScreenModel.typesOf(CreateProfilesConst.local).findIndex((type) => type.kind === 'existing')
      const opened = Run.numbered().on({ input: 'chooseType', index })

      expect(opened.effects).toEqual([{
        effect: 'fetchExistingSessions',
        categoryId: 'nodejs',
        projectName: 'AppJamatV3',
        projectPath: projectPathConst,
      }])
      expect(opened.state.existingAgentFilter).toBe('all')
      expect(CreateScreenModel.fieldsOf(opened.state))
        .toEqual(['type', 'agent', 'existingSessions'])
    })

    it('filters the cached rows by agent and resets the cursor', () => {
      const filtered = Run.existing()
        .on({ input: 'setExistingCursor', index: 1 })
        .on({ input: 'chooseExistingAgent', agentId: 'codex' })

      expect(CreateScreenModel.existingRowsOf(filtered.state).map((row) => row.nativeSessionId))
        .toEqual(['codex-1'])
      expect(filtered.state.existingCursor).toBe(0)
    })

    it('keeps the ordinary agent while All exists only as a history filter', () => {
      const index = CreateScreenModel.typesOf(CreateProfilesConst.local).findIndex((type) => type.kind === 'existing')
      const raw = Run.numbered().on({ input: 'chooseAgent', agentId: 'codex' })
      const existing = raw.on({ input: 'chooseType', index })
      const returned = existing.on({ input: 'chooseType', index: 0 })

      expect(existing.state.existingAgentFilter).toBe('all')
      expect(existing.state.agentId).toBe('codex')
      expect(returned.state.agentId).toBe('codex')
    })

    it('selects All again when a cached Continue/Fork list is revisited', () => {
      const index = CreateScreenModel.typesOf(CreateProfilesConst.local).findIndex((type) => type.kind === 'existing')
      const filtered = Run.existing().on({ input: 'chooseExistingAgent', agentId: 'codex' })
      const raw = filtered.on({ input: 'chooseType', index: 0 })
      const revisited = raw.on({ input: 'chooseType', index })

      expect(revisited.state.existingAgentFilter).toBe('all')
      expect(revisited.state.existingSessions).toEqual(existingConst)
      expect(revisited.effects).toEqual([])
    })

    it('uses the selected provider row to ask for one automatic history open', () => {
      const run = Run.existing()
        .on({ input: 'setExistingCursor', index: 1 })
        .on({ input: 'activate' })

      expect(run.effects).toEqual([{
        effect: 'openHistory',
        spec: {
          directory: {
            mode: 'project',
            categoryId: 'nodejs',
            projectPath: projectPathConst,
          },
          agentId: 'codex',
          nativeSessionId: 'codex-1',
          providerName: 'Codex work',
          providerActive: false,
        },
      }])
      expect(run.state.submitting).toBe(true)
    })

    it('carries the provider active hint without deciding what it means', () => {
      const run = Run.existing().on({ input: 'activate' })
      const effect = run.effects[0]

      expect(effect?.effect === 'openHistory' && effect.spec.providerActive).toBe(true)
    })

    it('does nothing on Enter while no matching conversation exists', () => {
      const empty = Run.existing([])
      expect(empty.on({ input: 'activate' }).effects).toEqual([])
      expect(CreateScreenModel.existingRefusal(empty.state)).toBe('nothing to continue')
    })

    it('walks the session rows and returns to Agent from the first one', () => {
      const atRows = Run.existing()
        .on({ input: 'setField', field: 'agent' })
        .on({ input: 'moveField', delta: 1 })
      expect(atRows.state.field).toBe('existingSessions')
      expect(atRows.on({ input: 'moveField', delta: 1 }).state.existingCursor).toBe(1)
      expect(atRows.on({ input: 'moveField', delta: -1 }).state.field).toBe('agent')
    })

    it('drops a history answer for another project', () => {
      const run = Run.existing().on({
        input: 'existingSessionsLoaded',
        categoryId: 'nodejs',
        projectName: 'SomethingElse',
        summaries: [],
      })
      expect(run.state.existingSessions).toEqual(existingConst)
    })

    it('keeps Continue/Fork disabled outside the catalog and skips it with the arrows', () => {
      const adHoc = Run.opened({ mode: 'adHoc', path: 'Q:/scratch' })
      const existing = CreateScreenModel.typesOf(CreateProfilesConst.local)
        .find((type) => type.kind === 'existing')
      if (!existing) throw new Error('Continue/Fork is absent')
      expect(CreateScreenModel.typeRefusal(adHoc.state, existing))
        .toBe('existing sessions need a catalog project')

      const flow = adHoc.on({ input: 'setField', field: 'type' }, { input: 'stepChoice', delta: 1 })
      const shell = flow.on({ input: 'stepChoice', delta: 1 })
      expect(CreateScreenModel.typeOf(shell.state).kind).toBe('shell')
    })

    it('does not build a new-session spec for an existing conversation', () => {
      expect(() => CreateScreenModel.specOf(Run.existing().state, '015'))
        .toThrow(/opened through openHistorySpecOf/)
    })
  })

  /**
   * The invariant. Nothing about the options can make Enter mean "not yet" - including the number
   * never arriving, which is the one thing on this screen that comes from somewhere else.
   */
  it('submits on Enter whatever the form is holding, number or no number', () => {
    expect(Run.numbered().on({ input: 'activate' }).effects).toEqual([{ effect: 'submit' }])
    expect(Run.opened().on({ input: 'activate' }).effects).toEqual([{ effect: 'submit' }])
    // The last type row is Shell, and it submits like Raw does.
    expect(Run.numbered().on({ input: 'chooseType', index: 99 }, { input: 'activate' }).effects)
      .toEqual([{ effect: 'submit' }])
  })

  /** A flow is configured before it starts, so its Enter opens a form and creates nothing. */
  it('opens the flow rather than submitting when the type row is one', () => {
    const run = Run.numbered().on({ input: 'chooseType', index: 1 })

    expect(CreateScreenModel.typeOf(run.state)).toEqual({ kind: 'flow', flowId: 'feature-request' })
    expect(run.on({ input: 'activate' }).effects)
      .toEqual([{ effect: 'openFlow', flowId: 'feature-request' }])
    // And nothing was marked as being created, since nothing was.
    expect(run.on({ input: 'activate' }).state.submitting).toBe(false)
  })

  it('takes a second Enter as nothing while the first is still in flight', () => {
    expect(Run.numbered().on({ input: 'activate' }, { input: 'activate' }).effects).toEqual([])
  })

  it('joins the number and the typed name into the title, and neither alone is a problem', () => {
    const named = Run.numbered().on({ input: 'nameChanged', name: 'session wizard' })

    expect(CreateScreenModel.titleOf(named.state, '015')).toBe('015 - session wizard')
    expect(CreateScreenModel.titleOf(Run.numbered().state, '015')).toBe('015')
    expect(CreateScreenModel.titleOf(named.state, null)).toBe('session wizard')
    expect(CreateScreenModel.titleOf(Run.numbered().state, null)).toBeUndefined()
  })

  /**
   * The title is what the slug comes from, so the branch carries the number by construction. That is
   * also how the number is read back out of the records without a field of its own.
   */
  it('builds the branch and the worktree path from the title', () => {
    const run = Run.numbered().on(
      { input: 'nameChanged', name: 'session wizard' },
      { input: 'chooseIsolation', worktree: true },
    )
    const preview = CreateScreenModel.worktreePreviewOf(run.state, '015')

    expect(preview).toEqual({
      slug: '015-session-wizard',
      branch: 'jamat/015-session-wizard',
      path: 'C:\\Projects\\NodeJs\\AppJamatV3\\.worktrees\\015-session-wizard',
    })
  })

  it('puts the title on the spec as the slug and never a base ref', () => {
    const run = Run.numbered().on(
      { input: 'nameChanged', name: 'session wizard' },
      { input: 'chooseIsolation', worktree: true },
    )
    const spec = CreateScreenModel.specOf(run.state, '015')

    expect(spec.title).toBe('015 - session wizard')
    expect(spec.worktree).toEqual({ slug: '015 - session wizard' })
    expect(spec.worktree?.baseRef).toBeUndefined()
  })

  /** The spec is built from the ALLOCATED number, never from the one the form was showing. */
  it('takes the token as a parameter rather than out of the state', () => {
    const run = Run.numbered('015').on({ input: 'nameChanged', name: 'wizard' })

    expect(CreateScreenModel.specOf(run.state, '016').title).toBe('016 - wizard')
    expect(CreateScreenModel.specOf(run.state, null).title).toBe('wizard')
  })

  it('builds an agent spec for Raw and a shell spec for Shell', () => {
    const raw = CreateScreenModel.specOf(Run.numbered().state, '015')
    expect(raw.kind).toBe('agent')
    expect(raw.agent).toEqual({ agentId: 'claude', mode: 'new' })

    const shell = CreateScreenModel.specOf(Run.shell().state, '015')
    expect(shell.kind).toBe('shell')
    expect(shell.agent).toBeUndefined()
  })

  it('refuses a worktree outside a catalog project, and says so', () => {
    const run = Run.opened({ mode: 'adHoc', path: 'D:\\w' })
      .on({ input: 'chooseIsolation', worktree: true })

    expect(CreateScreenModel.worktreeRefusal(run.state)).toBe('a worktree needs a catalog project')
    expect(run.state.worktree).toBe(false)
  })

  /**
   * With no number and no name the slug comes out empty, and git would refuse it one step later with
   * a message about slugs rather than about this screen. So this screen refuses first.
   */
  it('refuses a worktree that would have nothing to be named after', () => {
    const run = Run.opened().on({ input: 'numberLoaded', projectPath: projectPathConst, token: null })

    expect(CreateScreenModel.worktreeRefusal(run.state))
      .toBe('a worktree needs a name to be called after')
    expect(run.on({ input: 'chooseIsolation', worktree: true }).state.worktree).toBe(false)
    // And a name is enough on its own, with no number at all.
    expect(CreateScreenModel.worktreeRefusal(run.on({ input: 'nameChanged', name: 'x' }).state))
      .toBeNull()
  })

  it('turns a worktree off when the name it was called after is taken away', () => {
    const run = Run.opened()
      .on({ input: 'numberLoaded', projectPath: projectPathConst, token: null })
      .on({ input: 'nameChanged', name: 'wizard' }, { input: 'chooseIsolation', worktree: true })

    expect(run.state.worktree).toBe(true)
    expect(run.on({ input: 'nameChanged', name: '   ' }).state.worktree).toBe(false)
  })

  it('never refuses turning a worktree off', () => {
    const run = Run.opened({ mode: 'adHoc', path: 'D:\\w' })
      .on({ input: 'chooseIsolation', worktree: false })

    expect(run.state.worktree).toBe(false)
  })

  it('disables the agent on a shell and says why, rather than hiding it', () => {
    const shell = Run.shell()

    expect(CreateScreenModel.agentRefusal(shell.state)).toBe('a shell runs no agent')
    expect(shell.on({ input: 'chooseAgent', agentId: 'codex' }).state.agentId).toBe('claude')
    expect(CreateScreenModel.agentRefusal(Run.numbered().state)).toBeNull()
  })

  // It opens on the name so that the card can be typed into as it appears, which also makes the
  // name the top end the cursor stops at.
  it('walks the rows with the arrows and stops at both ends', () => {
    const run = Run.numbered()
    expect(run.state.field).toBe('name')
    expect(run.on({ input: 'moveField', delta: 1 }).state.field).toBe('type')
    expect(run.on({ input: 'moveField', delta: -1 }).state.field).toBe('name')
    expect(run.on({ input: 'moveField', delta: -1 }, { input: 'moveField', delta: -1 }).state.field)
      .toBe('name')
    expect(run.on(...Array(9).fill({ input: 'moveField', delta: 1 })).state.field).toBe('agent')
  })

  /** One keystroke, four meanings, decided by the row it is pressed on. */
  it('steps the choice on whichever row the cursor stands on', () => {
    const run = Run.numbered()

    expect(CreateScreenModel.typeOf(run.on(
      { input: 'setField', field: 'type' }, { input: 'stepChoice', delta: 1 },
    ).state).kind).toBe('flow')
    expect(run.on({ input: 'setField', field: 'isolation' }, { input: 'stepChoice', delta: 1 })
      .state.worktree).toBe(true)
    expect(run.on({ input: 'setField', field: 'agent' }, { input: 'stepChoice', delta: 1 })
      .state.agentId).toBe('codex')
    // On the name row the arrows belong to the text.
    expect(run.on({ input: 'setField', field: 'name' }, { input: 'stepChoice', delta: 1 })
      .state.field).toBe('name')
  })

  it('keeps a refused create on the screen and drops the answer that was refused with it', () => {
    const run = Run.numbered().on(
      { input: 'activate' },
      {
        input: 'submitFailed',
        code: 'setup-not-acknowledged',
        detail: 'the project asks to run its own commands',
        setup: { commands: ['pnpm install'], hash: 'abc' },
      },
    )

    expect(run.state.submitting).toBe(false)
    expect(run.state.submitError?.code).toBe('setup-not-acknowledged')
    expect(run.state.acknowledgeSetup).toBeNull()
  })

  it('answers the one refusal it can, by submitting again with the hash it was shown', () => {
    const run = Run.numbered()
      .on(
        { input: 'activate' },
        {
          input: 'submitFailed',
          code: 'setup-not-acknowledged',
          detail: 'asks to run its own commands',
          setup: { commands: ['pnpm install'], hash: 'abc' },
        },
        { input: 'acknowledgeSetup' },
      )

    expect(run.effects).toEqual([{ effect: 'submit' }])
    expect(CreateScreenModel.specOf(run.state, '015').acknowledgeSetup).toBe('abc')
  })

  it('leaves for the project screen on escape', () => {
    expect(Run.numbered().on({ input: 'escape' }).effects).toEqual([{ effect: 'back' }])
  })

  it('throws on an input it does not know', () => {
    expect(() => CreateScreenModel.transition(
      Run.numbered().state,
      { input: 'nope' } as unknown as CreateScreenInput,
    )).toThrow(/Unknown create screen input/)
  })

  /**
   * The same screen asking a shorter question: the same types minus the flows, and no isolation.
   * The profile names the FORM and not the result, which is the whole reason `New` and `Shell` from
   * it are plain tabs while `Continue/Fork` from it is a session of the tree.
   */
  describe('the tab profile', () => {
    it('offers the session types minus the flows', () => {
      expect(CreateScreenModel.typesOf(CreateProfilesConst.tab)).toEqual([
        { kind: 'raw' },
        { kind: 'existing' },
        { kind: 'shell' },
      ])
    })

    it('walks the name, the type and the agent, starting on the name', () => {
      const run = Run.tabProfile()
      expect(run.state.field).toBe('name')
      expect(CreateScreenModel.fieldsOf(run.state)).toEqual(['name', 'type', 'agent'])
      // Down from the name reaches the type and then the agent, and stops: isolation is not drawn.
      expect(run.on({ input: 'moveField', delta: 1 }).state.field).toBe('type')
      expect(run.on(
        { input: 'moveField', delta: 1 },
        { input: 'moveField', delta: 1 },
      ).state.field).toBe('agent')
      expect(run.on(
        { input: 'moveField', delta: 1 },
        { input: 'moveField', delta: 1 },
        { input: 'moveField', delta: 1 },
      ).state.field).toBe('agent')
    })

    it('takes no number, so a tab is never counted against its project', () => {
      const run = Run.tabProfile()
      expect(run.step.effects).toEqual([])
      expect(run.state.token).toBeNull()
    })

    it('answers the type but never the isolation', () => {
      const run = Run.tabProfile()
        .on({ input: 'chooseType', index: 99 }, { input: 'toggleWorktree' })
      // The list clamps at Shell, which is the last of the three.
      expect(CreateScreenModel.typeOf(run.state)).toEqual({ kind: 'shell' })
      expect(run.state.worktree).toBe(false)
      expect(CreateScreenModel.worktreeRefusal(run.state))
        .toBe('a tab runs without isolation')
    })

    it('builds a raw agent tab, with the name it was given and nothing else', () => {
      const run = Run.tabProfile()
        .on({ input: 'nameChanged', name: 'scratch' }, { input: 'cycleAgent' })

      expect(CreateScreenModel.specOf(run.state, null)).toEqual({
        kind: 'agent',
        directory: { mode: 'project', categoryId: 'nodejs', projectPath: projectConst.projectPath },
        title: 'scratch',
        agent: { agentId: 'codex', mode: 'new' },
        presentation: 'tab',
      })
    })

    it('builds a shell tab, which runs no agent', () => {
      const run = Run.tabProfile().on({ input: 'chooseType', index: 2 })

      expect(CreateScreenModel.specOf(run.state, null)).toEqual({
        kind: 'shell',
        directory: { mode: 'project', categoryId: 'nodejs', projectPath: projectConst.projectPath },
        presentation: 'tab',
      })
      expect(CreateScreenModel.agentRefusal(run.state)).toBe('a shell runs no agent')
    })

    /*
     * The one place the profile does NOT decide the result. Closing a plain tab discards its record,
     * so the library refuses to hold a fork in one: Continue/Fork opens through the history spec,
     * which has no presentation at all, and lands in the tree like every other kept session.
     */
    it('opens Continue/Fork as a session of the tree rather than as a tab', () => {
      const run = Run.tabProfile().on(
        { input: 'chooseType', index: 1 },
        {
          input: 'existingSessionsLoaded',
          categoryId: 'nodejs',
          projectName: projectConst.projectName,
          summaries: existingConst,
        },
      )
      expect(CreateScreenModel.typeOf(run.state)).toEqual({ kind: 'existing' })
      expect(CreateScreenModel.fieldsOf(run.state))
        .toEqual(['type', 'agent', 'existingSessions'])

      const opened = run.on({ input: 'activate' })
      const effect = opened.step.effects[0]
      if (effect?.effect !== 'openHistory') throw new Error('Continue/Fork did not open history')
      expect(effect.spec).not.toHaveProperty('presentation')
    })

    // No title at all rather than an empty one: the library names it after the directory.
    it('leaves the title to the library when nothing was typed', () => {
      expect(CreateScreenModel.specOf(Run.tabProfile().state, null).title).toBeUndefined()
    })
  })

  /*
   * The third profile. It is the SAME form asked of another computer, so what differs is only the
   * data source, the channel and the rows that mean nothing over there - and every one of the last
   * is said out loud rather than simply absent.
   */
  describe('the remote profile', () => {
    it('offers the session types minus the flows, the same short list the tab card asks', () => {
      expect(CreateScreenModel.typesOf(CreateProfilesConst.remote)).toEqual([
        { kind: 'raw' },
        { kind: 'existing' },
        { kind: 'shell' },
      ])
    })

    /*
     * A number is a project's own running count, kept by the machine that holds the project. The
     * one thing this card DOES ask for is what the target can start an agent on, which is a
     * question about that computer and cannot be answered from here.
     */
    it('asks this machine for nothing and the target only what it can run', () => {
      expect(Run.remote().effects)
        .toEqual([{ effect: 'describeAgents', remoteEndpointId: 'endpoint-a' }])
      expect(Run.remote().state.token).toBeNull()
      expect(Run.remote().state.models).toEqual({ status: 'loading' })
    })

    it('drops the isolation row and refuses a worktree in words', () => {
      const run = Run.remote()

      expect(CreateScreenModel.fieldsOf(run.state)).toEqual(['name', 'type', 'agent', 'model'])
      expect(CreateScreenModel.worktreeRefusal(run.state))
        .toBe('worktree isolation is set up on the target computer')
      expect(run.on({ input: 'toggleWorktree' }).state.worktree).toBe(false)
    })

    it('names every row it does not draw', () => {
      expect(CreateScreenModel.remoteRefusals(Run.remote().state)).toEqual([
        'Flows run where they were defined; this card starts on another computer.',
        'A plain tab lives outside the tree; the remote card starts tree sessions only.',
        'Worktree isolation is set up on the target; use the CLI --worktree for now.',
        'The number belongs to that project on that computer, which names the session itself.',
        "The session opens in a tab here; nothing is opened on the target's own screen.",
      ])
      expect(CreateScreenModel.remoteRefusals(Run.opened().state)).toEqual([])
    })

    // The target's own sessions, off the snapshot it already pushed; no provider history is read.
    it('fills Continue from the target rather than from this machine', () => {
      const chosen = Run.remote().on({ input: 'chooseType', index: 1 })

      expect(chosen.effects).toEqual([{
        effect: 'fetchRemoteSessions',
        remoteEndpointId: 'endpoint-a',
        projectPath: projectConst.mode === 'project' ? projectConst.projectPath : '',
      }])

      const loaded = chosen.on({
        input: 'remoteSessionsLoaded',
        projectPath: projectConst.mode === 'project' ? projectConst.projectPath : '',
        sessions: remoteSessionsConst,
      })
      expect(CreateScreenModel.existingDisplayRowsOf(loaded.state).map((row) => row.label))
        .toEqual(['007 - the wire', '008 - the listener'])
      expect(CreateScreenModel.existingDisplayRowsOf(loaded.state).map((row) => row.times))
        .toEqual([null, null])
    })

    it('drops an answer about a project this card is no longer showing', () => {
      const chosen = Run.remote().on({ input: 'chooseType', index: 1 })

      const late = chosen.on({
        input: 'remoteSessionsLoaded',
        projectPath: 'C:\\Projects\\NodeJs\\SomethingElse',
        sessions: remoteSessionsConst,
      })

      expect(late.state.remoteSessions).toBeNull()
    })

    /*
     * Enter on a running session only opens its tab here; an ended one is asked to reopen on the
     * target first. The same two steps its row in the tree takes, which is what makes the card and
     * the row one behaviour rather than two.
     */
    it('reopens an ended target session and only draws a running one', () => {
      const listed = Run.remote().on(
        { input: 'chooseType', index: 1 },
        {
          input: 'remoteSessionsLoaded',
          projectPath: projectConst.mode === 'project' ? projectConst.projectPath : '',
          sessions: remoteSessionsConst,
        },
      )

      expect(listed.on({ input: 'activate' }).effects).toEqual([{
        effect: 'openRemoteSession',
        remoteEndpointId: 'endpoint-a',
        sessionId: 'remote-1',
        tabTitle: 'AppJamatV3 - 007',
        running: false,
      }])
      expect(listed.on({ input: 'setExistingCursor', index: 1 }, { input: 'activate' }).effects)
        .toEqual([{
          effect: 'openRemoteSession',
          remoteEndpointId: 'endpoint-a',
          sessionId: 'remote-2',
          tabTitle: 'AppJamatV3 - 008',
          running: true,
        }])
    })

    it('builds a spec with no tab presentation, no worktree and no number', () => {
      const run = Run.remote().on({ input: 'nameChanged', name: 'the wire' })

      expect(CreateScreenModel.specOf(run.state, null)).toEqual({
        kind: 'agent',
        directory: { mode: 'project', categoryId: 'nodejs', projectPath: projectConst.mode === 'project' ? projectConst.projectPath : '' },
        title: 'the wire',
        agent: { agentId: 'claude', mode: 'new' },
        worktree: undefined,
        acknowledgeSetup: undefined,
        presentation: undefined,
      })
    })

    /*
     * The offer comes from the TARGET, not from this machine's catalog, which would name the CLI
     * versions of the wrong computer. `Target default` names what that computer has configured, so
     * leaving the row alone is a decision somebody can read rather than a blank.
     */
    it('offers the target’s own catalog and names what that computer has configured', () => {
      const run = Run.described()

      expect(CreateScreenModel.modelOptionsOf(run.state).map((option) => option.label))
        .toEqual(['Target default (opus)', 'Opus (newest)', 'Claude Fable 5'])
      expect(CreateScreenModel.modelRefusal(run.state)).toBeNull()
      expect(run.state.modelId).toBeNull()
    })

    /* An id that left the target's catalog keeps working there, so it is drawn - as a bare id. */
    it('draws a configured model outside the target catalog as a bare extra entry', () => {
      const codex = Run.described().on({ input: 'chooseAgent', agentId: 'codex' })

      expect(CreateScreenModel.modelOptionsOf(codex.state)).toEqual([
        { id: null, label: 'Target default (gpt-5.4-retired)', note: null },
        { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', note: null },
        { id: 'gpt-5.4-retired', label: 'gpt-5.4-retired', note: null },
      ])
    })

    it('carries an explicit model into the spec and nothing at all when left at the default', () => {
      const chosen = Run.described().on({ input: 'chooseModel', modelId: 'claude-fable-5' })
      const left = Run.described()

      expect(CreateScreenModel.specOf(chosen.state, null).agent)
        .toEqual({ agentId: 'claude', mode: 'new', model: 'claude-fable-5' })
      expect(CreateScreenModel.specOf(left.state, null).agent)
        .toEqual({ agentId: 'claude', mode: 'new' })
    })

    /*
     * THE degradation. A target that predates `agents.describe` never negotiated the capability, so
     * the ask is refused - and its create validator reads exact keys, so a `model` sent to it would
     * be refused as an invalid request in full rather than ignored. The row therefore says what
     * will happen instead of going quiet, and the field never travels.
     */
    it('never sends a model to a target that did not offer agents.describe, and says so', () => {
      const refused = Run.remote().on({
        input: 'agentsDescribeFailed',
        remoteEndpointId: 'endpoint-a',
        refused: true,
        detail: 'agents.describe is not allowed for remote-peer',
      })

      expect(CreateScreenModel.modelOptionsOf(refused.state)).toEqual([])
      expect(CreateScreenModel.modelRefusal(refused.state))
        .toBe('Studio does not offer model selection; it starts on the model it has configured')
      expect(CreateScreenModel.chosenModelOf(refused.state)).toBeUndefined()
      expect(CreateScreenModel.specOf(refused.state, null).agent)
        .toEqual({ agentId: 'claude', mode: 'new' })
      // A refusal is that computer's answer and stands: nothing to ask again.
      expect(CreateScreenModel.modelRetryable(refused.state)).toBe(false)
      expect(refused.on({ input: 'retryDescribe' }).effects).toEqual([])
    })

    /* A target that could not answer is a different case: the same degradation, plus asking again. */
    it('offers to ask again after an answer that never arrived', () => {
      const lost = Run.remote().on({
        input: 'agentsDescribeFailed',
        remoteEndpointId: 'endpoint-a',
        refused: false,
        detail: 'Remote AppClientUI disconnected',
      })

      expect(CreateScreenModel.modelRefusal(lost.state))
        .toBe('Studio could not be asked which models it offers (Remote AppClientUI disconnected)')
      expect(CreateScreenModel.modelRetryable(lost.state)).toBe(true)
      expect(lost.on({ input: 'retryDescribe' }).effects)
        .toEqual([{ effect: 'describeAgents', remoteEndpointId: 'endpoint-a' }])
      expect(CreateScreenModel.specOf(lost.state, null).agent)
        .toEqual({ agentId: 'claude', mode: 'new' })
    })

    it('drops an answer about a computer this card is no longer aimed at', () => {
      const late = Run.remote().on({
        input: 'agentsDescribed',
        remoteEndpointId: 'endpoint-b',
        agents: describedAgentsConst,
      })

      expect(late.state.models).toEqual({ status: 'loading' })
    })

    /* The target answers per agent, so a model chosen for one is not one the other has. */
    it('drops the chosen model when the agent changes', () => {
      const switched = Run.described().on(
        { input: 'chooseModel', modelId: 'claude-fable-5' },
        { input: 'chooseAgent', agentId: 'codex' },
      )

      expect(switched.state.modelId).toBeNull()
      expect(CreateScreenModel.specOf(switched.state, null).agent)
        .toEqual({ agentId: 'codex', mode: 'new' })
    })

    it('refuses a model the target never offered and steps only through the ones it did', () => {
      const stale = Run.described().on({ input: 'chooseModel', modelId: 'claude-opus-9' })
      const stepped = Run.described().on(
        { input: 'setField', field: 'model' },
        { input: 'stepChoice', delta: 1 },
      )

      expect(stale.state.modelId).toBeNull()
      expect(stepped.state.modelId).toBe('opus')
      expect(CreateScreenModel.modelNoteOf(stepped.state)).toBe('always the newest Opus')
    })

    it('has no model row on a local card and refuses one for a shell', () => {
      expect(CreateScreenModel.modelRefusal(Run.opened().state)).toBeNull()
      expect(CreateScreenModel.modelOptionsOf(Run.opened().state)).toEqual([])
      expect(CreateScreenModel.chosenModelOf(Run.opened().state)).toBeUndefined()

      const shell = Run.described().on({ input: 'chooseType', index: 2 })
      expect(CreateScreenModel.modelRefusal(shell.state)).toBe('a shell runs no agent')
    })

    /*
     * The whole reason the request is in the state. The far side keys its replay store by the
     * operation id, so a Retry after an answer that never arrived has to send the same id AND the
     * same body or it founds a second session - and every decided answer has to drop it, or a
     * later attempt would replay a decision instead of asking its own question.
     */
    it('keeps the request of an uncertain answer and drops it after a decided one', () => {
      const uncertain = Run.remote().on(
        { input: 'activate' },
        {
          input: 'submitFailed',
          code: 'timeout',
          detail: 'no answer',
          retryCreate: { operationId: 'op-1', spec: sentSpecConst },
        },
      )
      expect(uncertain.state.pendingCreate)
        .toEqual({ operationId: 'op-1', spec: sentSpecConst })
      expect(uncertain.state.submitting).toBe(false)

      const decided = uncertain.on(
        { input: 'activate' },
        { input: 'submitFailed', code: 'invalid-request', detail: 'no' },
      )
      expect(decided.state.pendingCreate).toBeNull()
    })

    // A decided answer with a different body next time: the same id would be a conflict, not a replay.
    it('gives a confirmed setup a new operation id', () => {
      const asked = Run.remote().on(
        { input: 'activate' },
        {
          input: 'submitFailed',
          code: 'setup-not-acknowledged',
          detail: 'the project asks to run its own commands',
          setup: { commands: ['pnpm install'], hash: 'hash-1' },
          retryCreate: { operationId: 'op-1', spec: sentSpecConst },
        },
      )
      expect(asked.state.pendingCreate).not.toBeNull()

      const agreed = asked.on({ input: 'acknowledgeSetup' })

      expect(agreed.state.pendingCreate).toBeNull()
      expect(agreed.state.acknowledgeSetup).toBe('hash-1')
      expect(agreed.effects).toEqual([{ effect: 'submit' }])
    })

    // Losing the computer mid-flow is a state, not a fault: the form stays, the submit stops.
    it('keeps the card and starts nothing once the target is gone', () => {
      const lost = Run.remote().on(
        { input: 'nameChanged', name: 'the wire' },
        { input: 'targetLost' },
      )

      expect(lost.state.targetLost).toBe(true)
      expect(lost.state.name).toBe('the wire')
      expect(lost.on({ input: 'activate' }).effects).toEqual([])
    })

    it('throws on a target kind nobody has decided about', () => {
      expect(() => CreateScreenModel.endpointOf({ kind: 'relayed' } as never))
        .toThrow(/Unknown launcher target/)
    })
  })
})
