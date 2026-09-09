import type { IpcMainInvokeEvent } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SessionManager } from '../../../lib-orchestrator/sessionManager/sessionManager'
import type {
  SessionCreateSpec,
  SessionDetailsUpdate,
  SessionHistoryOpenSpec,
  SessionsSnapshot,
} from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { AppClientUiIpcInvokeMap } from '../../shared/appClientUiIpc'
import { ServiceSessionsIpc } from './serviceSessionsIpc'

const ipcMainMock = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      ipcMainMock.handlers.set(channel, handler)
    },
  },
}))

describe('app-client-ui/app/sessions/serviceSessionsIpc', () => {
  const snapshotConst: SessionsSnapshot = {
    revision: 7,
    reconciled: false,
    host: {
      presence: 'unreachable',
      hostVersion: null,
      hostInstanceId: null,
      liveCount: 0,
      lastStartError: null,
    },
    categories: [],
    sessions: [],
    orphans: [],
  }
  const specConst: SessionCreateSpec = { kind: 'shell', directory: { mode: 'default' } }
  const historySpecConst: SessionHistoryOpenSpec = {
    directory: { mode: 'project', categoryId: 'code', projectPath: 'Q:/x/AppJamatV3' },
    agentId: 'codex',
    nativeSessionId: 'native-7',
    providerName: 'Numbered task',
    providerActive: false,
  }
  /** A diff on purpose: the channel forwards whatever subset of the fields the save carries. */
  const updateConst: SessionDetailsUpdate = { name: 'renamed', color: 'sky' }

  const calls: { method: string; args: unknown[] }[] = []
  let service: ServiceSessionsIpc

  /** Records what each channel forwarded; what the answers mean is the library's own tests. */
  function recordingManager(): SessionManager {
    const record = (method: string) => (...args: unknown[]) => {
      calls.push({ method, args })
      return Promise.resolve({ ok: true, value: method })
    }
    return {
      snapshot: () => snapshotConst,
      createSession: record('createSession'),
      historyReferences: record('historyReferences'),
      openHistorySession: record('openHistorySession'),
      reopenSession: record('reopenSession'),
      finalizeSession: record('finalizeSession'),
      removeSession: record('removeSession'),
      discardPlainSession: record('discardPlainSession'),
      promotePlainSession: record('promotePlainSession'),
      forkSession: record('forkSession'),
      newSessionBeside: record('newSessionBeside'),
      restartSession: record('restartSession'),
      setSessionColor: record('setSessionColor'),
      setSessionDetails: record('setSessionDetails'),
      adoptOrphan: record('adoptOrphan'),
      discardWorktree: record('discardWorktree'),
      retrySetup: record('retrySetup'),
      nextSessionNumber: record('nextSessionNumber'),
      allocateSessionNumber: record('allocateSessionNumber'),
      startHost: record('startHost'),
      sessionReference: record('sessionReference'),
    } as unknown as SessionManager
  }

  beforeEach(() => {
    ipcMainMock.handlers.clear()
    calls.length = 0
    service = new ServiceSessionsIpc(recordingManager())
  })

  async function invoke(
    channel: keyof AppClientUiIpcInvokeMap,
    ...args: unknown[]
  ): Promise<unknown> {
    const handler = ipcMainMock.handlers.get(channel)
    if (!handler) throw new Error(`No handler for ${channel}`)
    return handler({} as IpcMainInvokeEvent, ...args)
  }

  it('registers a handler for every channel it declares', () => {
    service.initialize()
    expect([...ipcMainMock.handlers.keys()].sort())
      .toEqual(Object.keys(ServiceSessionsIpc.channelsConst).sort())
  })

  it('fails the boot when one of its channels has no handler', () => {
    const internals = service as unknown as {
      assertComplete(channels: typeof ServiceSessionsIpc.channelsConst): void
    }
    expect(() => internals.assertComplete(ServiceSessionsIpc.channelsConst))
      .toThrow(/IPC channel is not registered/)
  })

  it('forwards each channel to the manager with the arguments it was given', async () => {
    service.initialize()

    await invoke('sessions:create', specConst)
    await invoke('sessions:history-references', historySpecConst.directory)
    await invoke('sessions:open-history', historySpecConst)
    await invoke('sessions:reopen', 'session-1')
    await invoke('sessions:finalize', 'session-1')
    await invoke('sessions:remove', 'session-1')
    await invoke('sessions:close-plain', 'session-1')
    await invoke('sessions:promote-plain', 'session-1')
    await invoke('sessions:fork', 'session-1')
    // The two-argument ones, which are the whole reason a forwarding test is worth writing: a
    // swapped pair or a dropped second argument is invisible everywhere else.
    await invoke('sessions:new-beside', 'session-1', 'codex')
    await invoke('sessions:restart', 'session-1')
    await invoke('sessions:set-color', 'session-1', 'teal')
    await invoke('sessions:adopt-orphan', 'runtime-9')
    await invoke('sessions:discard-worktree', 'session-1')
    await invoke('sessions:retry-setup', 'session-1')
    await invoke('sessions:retry-setup', 'session-1', 'hash-9')
    await invoke('sessions:next-number', 'Q:/x/AppJamatV3')
    await invoke('sessions:allocate-number', 'Q:/x/AppJamatV3')
    await invoke('sessions:start-host')
    await invoke('sessions:reference', 'session-1')

    expect(calls).toEqual([
      { method: 'createSession', args: [specConst] },
      { method: 'historyReferences', args: [historySpecConst.directory] },
      { method: 'openHistorySession', args: [historySpecConst] },
      { method: 'reopenSession', args: ['session-1'] },
      { method: 'finalizeSession', args: ['session-1'] },
      { method: 'removeSession', args: ['session-1'] },
      { method: 'discardPlainSession', args: ['session-1'] },
      { method: 'promotePlainSession', args: ['session-1'] },
      { method: 'forkSession', args: ['session-1'] },
      { method: 'newSessionBeside', args: ['session-1', 'codex'] },
      { method: 'restartSession', args: ['session-1'] },
      { method: 'setSessionColor', args: ['session-1', 'teal'] },
      { method: 'adoptOrphan', args: ['runtime-9'] },
      { method: 'discardWorktree', args: ['session-1'] },
      { method: 'retrySetup', args: ['session-1', undefined] },
      { method: 'retrySetup', args: ['session-1', 'hash-9'] },
      { method: 'nextSessionNumber', args: ['Q:/x/AppJamatV3'] },
      { method: 'allocateSessionNumber', args: ['Q:/x/AppJamatV3'] },
      { method: 'startHost', args: [] },
      { method: 'sessionReference', args: ['session-1'] },
    ])
  })

  /*
   * The transport turns a throw into `{ ok: false }`, which is right and is also how the test above
   * used to be able to lie. A channel whose manager method did not exist answered a caught
   * `TypeError`, recorded no call, and the `toEqual` over `calls` passed - so four channels went
   * unforwarded and unnoticed. Asserting the failure shape is what makes a missing method visible
   * as something other than silence.
   */
  it('answers a handler that threw as a refused call rather than as nothing', async () => {
    service = new ServiceSessionsIpc({
      snapshot: () => snapshotConst,
      reopenSession: () => { throw new Error('the manager is gone') },
    } as unknown as SessionManager)
    service.initialize()

    expect(await invoke('sessions:reopen', 'session-1'))
      .toEqual({ ok: false, error: 'the manager is gone' })
    expect(calls).toEqual([])
  })

  it('forwards the details update whole and answers with what the manager said', async () => {
    service.initialize()

    expect(await invoke('sessions:set-details', 'session-1', updateConst)).toEqual({
      ok: true,
      value: { ok: true, value: 'setSessionDetails' },
    })
    expect(calls).toEqual([{ method: 'setSessionDetails', args: ['session-1', updateConst] }])
  })

  it('answers the snapshot channel with the whole snapshot, revision and all', async () => {
    service.initialize()
    expect(await invoke('sessions:snapshot')).toEqual({ ok: true, value: snapshotConst })
  })

  /**
   * A refusal is an answer: the renderer has to be able to say WHY a session would not go away, so
   * the domain result travels inside the transport's, and nothing here throws.
   */
  it('carries a refusal through as data rather than as a failed channel', async () => {
    const refusing = {
      removeSession: () =>
        Promise.resolve({ ok: false, code: 'live-refused', detail: 'The session is live' }),
    } as unknown as SessionManager
    const refusingService = new ServiceSessionsIpc(refusing)
    refusingService.initialize()

    expect(await invoke('sessions:remove', 'session-1')).toEqual({
      ok: true,
      value: { ok: false, code: 'live-refused', detail: 'The session is live' },
    })
  })
})
