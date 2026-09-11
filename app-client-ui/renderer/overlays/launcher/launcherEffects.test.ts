import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AppClientUiBridge } from '../../../shared/appClientUiIpc'
import type { TerminalTarget } from '../../../shared/terminalTarget'
import type { PanelOpenOutcome } from '../../shell/appShell.types'
import type { CreateScreenInput, CreateScreenState } from './create/createScreenModel'
import { CreateScreenModel } from './create/createScreenModel'
import { LauncherFixtures } from './fixtures/launcherFixtures'
import { LauncherEffects, type LauncherPorts } from './launcherEffects'
import type { LauncherInput } from './projects/launcherModel'

/**
 * The I/O layer of the launcher, and the one thing about it that cannot be seen from the models: an
 * answer has to say which project it is an answer ABOUT. The models drop a mismatch, and a model
 * cannot tell that the effect handed it the wrong name in the first place.
 */
describe('app-client-ui/renderer/overlays/launcher/launcherEffects', () => {
  afterEach(() => {
    delete (window as unknown as { appClient?: unknown }).appClient
  })

  /** Only what a history read touches; everything else on the bridge would be noise here. */
  function install(answer: 'ok' | 'refused' | 'unreachable'): void {
    const sessions = (): Promise<unknown> => {
      if (answer === 'unreachable')
        return Promise.resolve({ ok: false as const, error: 'the main process is gone' })
      if (answer === 'refused')
        return Promise.resolve({
          ok: true as const,
          value: { ok: false as const, code: 'not-found', detail: 'no such project' },
        })
      return Promise.resolve({
        ok: true as const,
        value: { ok: true as const, value: { merged: [], claude: [], codex: [] } },
      })
    }
    const historyReferences = (): Promise<unknown> => Promise.resolve({
      ok: true as const,
      value: { ok: true as const, value: { references: [] } },
    })
    ;(window as unknown as {
      appClient: {
        projects: Pick<AppClientUiBridge['projects'], 'sessions'>
        sessions: Pick<AppClientUiBridge['sessions'], 'historyReferences'>
      }
    }).appClient = {
      projects: { sessions } as Pick<AppClientUiBridge['projects'], 'sessions'>,
      sessions: {
        historyReferences,
      } as Pick<AppClientUiBridge['sessions'], 'historyReferences'>,
    }
  }

  async function read(answer: 'ok' | 'refused' | 'unreachable'): Promise<CreateScreenInput[]> {
    install(answer)
    const reported: CreateScreenInput[] = []
    const ports = {
      create: (input: CreateScreenInput) => reported.push(input),
    } as unknown as LauncherPorts
    await LauncherEffects.runCreate(
      {
        effect: 'fetchExistingSessions',
        categoryId: 'nodejs',
        projectName: 'AppJamatV3',
        projectPath: 'C:/Projects/NodeJs/AppJamatV3',
      },
      CreateScreenModel.opened({
        mode: 'project',
        categoryId: 'nodejs',
        projectName: 'AppJamatV3',
        projectPath: 'C:/Projects/NodeJs/AppJamatV3',
      }).state,
      ports,
    )
    return reported
  }

  it('names the project its summaries are of', async () => {
    expect(await read('ok')).toEqual([{
      input: 'existingSessionsLoaded',
      categoryId: 'nodejs',
      projectName: 'AppJamatV3',
      summaries: [],
    }])
  })

  it('returns the sort that produced a project listing', async () => {
    const list = vi.fn(async () => ({
      ok: true as const,
      value: { ok: true as const, value: LauncherFixtures.web() },
    }))
    ;(window as unknown as {
      appClient: { projects: Pick<AppClientUiBridge['projects'], 'list'> }
    }).appClient = {
      projects: { list } as Pick<AppClientUiBridge['projects'], 'list'>,
    }
    const reported: LauncherInput[] = []

    await LauncherEffects.run(
      { effect: 'fetchProjects', categoryId: 'web', sort: 'alpha', remoteEndpointId: null },
      { dispatch: (input: LauncherInput) => reported.push(input) } as unknown as LauncherPorts,
    )

    expect(list).toHaveBeenCalledWith('web', 'alpha')
    expect(reported).toEqual([{
      input: 'projectsLoaded',
      categoryId: 'web',
      sort: 'alpha',
      listing: LauncherFixtures.web(),
    }])
  })

  it('returns the category and sort that a project listing failure belongs to', async () => {
    const list = vi.fn(async () => ({ ok: false as const, error: 'bridge down' }))
    ;(window as unknown as {
      appClient: { projects: Pick<AppClientUiBridge['projects'], 'list'> }
    }).appClient = {
      projects: { list } as Pick<AppClientUiBridge['projects'], 'list'>,
    }
    const reported: LauncherInput[] = []

    await LauncherEffects.run(
      { effect: 'fetchProjects', categoryId: 'web', sort: 'alpha', remoteEndpointId: null },
      { dispatch: (input: LauncherInput) => reported.push(input) } as unknown as LauncherPorts,
    )

    expect(reported).toEqual([{
      input: 'projectsLoadFailed',
      categoryId: 'web',
      sort: 'alpha',
      detail: 'bridge down',
    }])
  })

  // Both failures too: a failure written into another project's screen is a red line about a
  // project that is fine, on a screen that is still waiting for its own answer.
  it('names the project a refusal is about', async () => {
    expect(await read('refused')).toEqual([{
      input: 'existingSessionsFailed',
      categoryId: 'nodejs',
      projectName: 'AppJamatV3',
      detail: 'not-found: no such project',
    }])
  })

  it('names the project a channel failure is about', async () => {
    expect(await read('unreachable')).toEqual([{
      input: 'existingSessionsFailed',
      categoryId: 'nodejs',
      projectName: 'AppJamatV3',
      detail: 'the main process is gone',
    }])
  })

  /*
   * The remote half. What is proven here is the thing no model can prove: which computer was asked,
   * with which id, and whether a second attempt is the same operation or another one.
   */
  describe('a card aimed at another computer', () => {
    const remoteTargetConst = {
      kind: 'remote' as const,
      remoteEndpointId: 'endpoint-a',
      displayName: 'Studio',
    }
    const bindingConst = {
      mode: 'project' as const,
      categoryId: 'nodejs',
      projectName: 'AppJamatV3',
      projectPath: 'C:/Projects/NodeJs/AppJamatV3',
    }

    function remoteState(overrides: Partial<CreateScreenState> = {}) {
      return {
        ...CreateScreenModel.opened(bindingConst, { target: remoteTargetConst }).state,
        ...overrides,
      }
    }

    function installRemote(answers: {
      createSession?: unknown
      describeAgents?: unknown
      listProjects?: unknown
      snapshot?: unknown
    }, record: { calls: unknown[][] }) {
      ;(window as unknown as { appClient: unknown }).appClient = {
        remote: {
          selectSession: () => Promise.resolve({ ok: true, value: { ok: true, value: undefined } }),
          createSession: (...args: unknown[]) => {
            record.calls.push(['createSession', ...args])
            return Promise.resolve(answers.createSession)
          },
          describeAgents: (...args: unknown[]) => {
            record.calls.push(['describeAgents', ...args])
            return Promise.resolve(answers.describeAgents)
          },
          listProjects: (...args: unknown[]) => {
            record.calls.push(['listProjects', ...args])
            return Promise.resolve(answers.listProjects)
          },
          snapshot: () => {
            record.calls.push(['snapshot'])
            return Promise.resolve(answers.snapshot)
          },
        },
      }
    }

    function portsOf(
      reported: CreateScreenInput[],
      openTerminal: (target: TerminalTarget) => Promise<PanelOpenOutcome> = () =>
        Promise.resolve({ kind: 'opened', panelId: 'terminal' }),
    ): LauncherPorts {
      return {
        create: (input: CreateScreenInput) => reported.push(input),
        openTerminal,
        markHandedOff: () => undefined,
        close: () => undefined,
      } as unknown as LauncherPorts
    }

    /**
     * The one that matters. A create whose answer never arrived is retried with the id the screen
     * kept, so the far side's replay store answers with what it decided rather than founding a
     * second session. A fresh id per call is exactly the bug this holds shut.
     */
    it('sends the same operation id again after an uncertain answer', async () => {
      const record = { calls: [] as unknown[][] }
      installRemote({
        createSession: { ok: true, value: { ok: false, error: { code: 'timeout', detail: 'no answer' } } },
      }, record)
      const reported: CreateScreenInput[] = []

      await LauncherEffects.runCreate({ effect: 'submit' }, remoteState(), portsOf(reported))
      const first = reported[0]
      if (first?.input !== 'submitFailed') throw new Error('The first attempt did not fail')
      expect(first.retryCreate?.operationId).toBeTypeOf('string')

      // The name is typed into between the two attempts: the retry must still send what the first
      // one sent, because the same id with a different body is a conflict rather than a replay.
      await LauncherEffects.runCreate(
        { effect: 'submit' },
        remoteState({ pendingCreate: first.retryCreate ?? null, name: 'typed after the timeout' }),
        portsOf(reported),
      )

      const sent = record.calls.filter((call) => call[0] === 'createSession')
      expect(sent).toHaveLength(2)
      expect(sent[0]?.[1]).toBe('endpoint-a')
      expect(sent[1]?.[3]).toBe(sent[0]?.[3])
      expect(sent[1]?.[3]).toBe(first.retryCreate?.operationId)
      expect(sent[1]?.[2]).toEqual(sent[0]?.[2])
    })

    // A decided refusal is not replayed: the id is dropped, and the next attempt mints its own.
    it('drops the operation id when the answer was a decision', async () => {
      const record = { calls: [] as unknown[][] }
      installRemote({
        createSession: {
          ok: true,
          value: { ok: false, error: { code: 'invalid-request', detail: 'the spec is wrong' } },
        },
      }, record)
      const reported: CreateScreenInput[] = []

      await LauncherEffects.runCreate({ effect: 'submit' }, remoteState(), portsOf(reported))

      expect(reported).toEqual([{
        input: 'submitFailed',
        code: 'invalid-request',
        detail: 'the spec is wrong',
      }])
    })

    // The channel failing says nothing about whether the request reached that computer.
    it('treats a channel failure as the most uncertain answer there is', async () => {
      const record = { calls: [] as unknown[][] }
      installRemote({ createSession: { ok: false, error: 'the main process is gone' } }, record)
      const reported: CreateScreenInput[] = []

      await LauncherEffects.runCreate({ effect: 'submit' }, remoteState(), portsOf(reported))

      const failure = reported[0]
      if (failure?.input !== 'submitFailed') throw new Error('The attempt did not fail')
      expect(failure.code).toBe('transport')
      expect(failure.retryCreate?.operationId).toBe(record.calls[0]?.[3])
    })

    it('draws the tab of a session founded on that computer, through that endpoint', async () => {
      const record = { calls: [] as unknown[][] }
      installRemote({
        createSession: {
          ok: true,
          value: {
            ok: true,
            value: { session: { sessionId: 'remote-9', tabTitle: 'AppJamatV3 - 009' } },
          },
        },
      }, record)
      const opened: [TerminalTarget, string][] = []
      const ports = portsOf([], (target) => {
        opened.push([target, 'AppJamatV3 - 009'])
        return Promise.resolve({ kind: 'opened', panelId: 'terminal' })
      })

      await LauncherEffects.runCreate({ effect: 'submit' }, remoteState(), ports)

      expect(opened).toEqual([[
        { kind: 'remote', remoteEndpointId: 'endpoint-a', sessionId: 'remote-9' },
        'AppJamatV3 - 009',
      ]])
    })

    /*
     * The reading half of the model row, and the one answer that decides the whole feature.
     * `forbidden` comes back WITHOUT a round trip - the peer channel never negotiated the
     * capability - and it is reported as a refusal rather than as a failure, because a refusal is
     * that target's final answer and the offer must never be drawn for it.
     */
    it('reads the target’s agents and marks a target without the capability as refused', async () => {
      const record = { calls: [] as unknown[][] }
      const reported: CreateScreenInput[] = []
      installRemote({
        describeAgents: {
          ok: true,
          value: {
            ok: true,
            value: {
              agents: [
                { agentId: 'claude', configuredModel: 'opus', models: [] },
                // Not an agent this build knows, and one with no catalog at all: both are dropped
                // rather than drawn, because the value crossed two processes and a network.
                { agentId: 'gemini', configuredModel: null, models: [] },
                { agentId: 'codex', configuredModel: null, models: 'all of them' },
              ],
            },
          },
        },
      }, record)

      await LauncherEffects.runCreate(
        { effect: 'describeAgents', remoteEndpointId: 'endpoint-a' },
        remoteState(),
        portsOf(reported),
      )

      expect(record.calls).toEqual([['describeAgents', 'endpoint-a']])
      expect(reported).toEqual([{
        input: 'agentsDescribed',
        remoteEndpointId: 'endpoint-a',
        agents: [{ agentId: 'claude', configuredModel: 'opus', models: [] }],
      }])

      const refused: CreateScreenInput[] = []
      installRemote({
        describeAgents: {
          ok: true,
          value: {
            ok: false,
            error: { code: 'forbidden', detail: 'Remote peer did not grant agents.describe' },
          },
        },
      }, record)
      await LauncherEffects.runCreate(
        { effect: 'describeAgents', remoteEndpointId: 'endpoint-a' },
        remoteState(),
        portsOf(refused),
      )

      expect(refused).toEqual([{
        input: 'agentsDescribeFailed',
        remoteEndpointId: 'endpoint-a',
        refused: true,
        detail: 'Remote peer did not grant agents.describe',
      }])
    })

    /* Anything but `forbidden` may answer differently next time, so the row offers to ask again. */
    it('marks an unreachable target as askable rather than as a refusal', async () => {
      const record = { calls: [] as unknown[][] }
      const reported: CreateScreenInput[] = []
      installRemote({
        describeAgents: {
          ok: true,
          value: { ok: false, error: { code: 'timeout', detail: 'no answer' } },
        },
      }, record)

      await LauncherEffects.runCreate(
        { effect: 'describeAgents', remoteEndpointId: 'endpoint-a' },
        remoteState(),
        portsOf(reported),
      )

      expect(reported).toEqual([{
        input: 'agentsDescribeFailed',
        remoteEndpointId: 'endpoint-a',
        refused: false,
        detail: 'no answer',
      }])
    })

    it('seeds the whole catalog from one call and names the computer it asked', async () => {
      const record = { calls: [] as unknown[][] }
      installRemote({
        listProjects: {
          ok: true,
          value: {
            ok: true,
            value: {
              categories: [
                {
                  category: LauncherFixtures.categories()[0],
                  listing: { ok: true, value: LauncherFixtures.nodejs() },
                },
                {
                  category: LauncherFixtures.categories()[1],
                  listing: { ok: false, code: 'not-found', detail: 'gone' },
                },
              ],
            },
          },
        },
      }, record)
      const reported: LauncherInput[] = []

      await LauncherEffects.run(
        { effect: 'fetchCategories', remoteEndpointId: 'endpoint-a' },
        { dispatch: (input: LauncherInput) => reported.push(input) } as unknown as LauncherPorts,
      )

      expect(record.calls).toEqual([['listProjects', 'endpoint-a', {}]])
      expect(reported).toEqual([
        {
          input: 'projectsLoaded',
          remoteEndpointId: 'endpoint-a',
          categoryId: 'nodejs',
          sort: 'recent',
          listing: LauncherFixtures.nodejs(),
        },
        { input: 'projectsLoadFailed', remoteEndpointId: 'endpoint-a', categoryId: 'web', sort: 'recent', detail: 'not-found: gone' },
        { input: 'categoriesLoaded', remoteEndpointId: 'endpoint-a', categories: LauncherFixtures.categories().slice(0, 2) },
      ])
    })

    it('reads the target sessions of one project off the snapshot, without asking over the wire', async () => {
      const record = { calls: [] as unknown[][] }
      installRemote({
        snapshot: {
          ok: true,
          value: {
            revision: 1,
            inbound: [],
            outbound: [{
              remoteEndpointId: 'endpoint-a',
              status: 'connected',
              sessions: {
                sessions: [
                  {
                    sessionId: 'remote-1',
                    tabTitle: 'AppJamatV3 - 007',
                    title: '007 - the wire',
                    life: 'ended',
                    agent: { agentId: 'claude' },
                    project: { kind: 'project', projectPath: bindingConst.projectPath },
                  },
                  {
                    sessionId: 'other-1',
                    tabTitle: 'Elsewhere - 001',
                    title: '001 - elsewhere',
                    life: 'live',
                    project: { kind: 'project', projectPath: 'Q:/elsewhere' },
                  },
                  {
                    sessionId: 'tab-1',
                    tabTitle: 'AppJamatV3 - tab',
                    title: 'a tab',
                    life: 'live',
                    presentation: 'tab',
                    project: { kind: 'project', projectPath: bindingConst.projectPath },
                  },
                ],
              },
            }],
          },
        },
      }, record)
      const reported: CreateScreenInput[] = []

      await LauncherEffects.runCreate(
        {
          effect: 'fetchRemoteSessions',
          remoteEndpointId: 'endpoint-a',
          projectPath: bindingConst.projectPath,
        },
        remoteState(),
        portsOf(reported),
      )

      expect(reported).toEqual([{
        input: 'remoteSessionsLoaded',
        projectPath: bindingConst.projectPath,
        sessions: [{
          sessionId: 'remote-1',
          tabTitle: 'AppJamatV3 - 007',
          title: '007 - the wire',
          agentId: 'claude',
          running: false,
        }],
      }])
    })

    it('says so rather than listing nothing when the computer has gone', async () => {
      const record = { calls: [] as unknown[][] }
      installRemote({
        snapshot: {
          ok: true,
          value: {
            revision: 1,
            inbound: [],
            outbound: [{ remoteEndpointId: 'endpoint-a', status: 'offline', sessions: null }],
          },
        },
      }, record)
      const reported: CreateScreenInput[] = []

      await LauncherEffects.runCreate(
        {
          effect: 'fetchRemoteSessions',
          remoteEndpointId: 'endpoint-a',
          projectPath: bindingConst.projectPath,
        },
        remoteState(),
        portsOf(reported),
      )

      expect(reported).toEqual([{
        input: 'remoteSessionsFailed',
        projectPath: bindingConst.projectPath,
        detail: 'That computer is no longer connected.',
      }])
    })
  })
})
