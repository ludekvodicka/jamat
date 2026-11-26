import { EventEmitter } from 'node:events'

import { describe, expect, it } from 'vitest'

import { AppClientUiBridgeEventsConst, AppClientUiChannelOwnersConst, OrchestratorChannelsConst } from '../../../lib-orchestrator/clientApi/appClientUiIpc'
import { bindService, callerSource, handlers } from '../serviceTransportTestHarness'
import { ServiceSessionUncommittedIpc } from './serviceSessionUncommittedIpc'

describe('app/sessionUncommitted/serviceSessionUncommittedIpc', () => {
  it('is a channel pair of the orchestrator owner', () => {
    expect(AppClientUiChannelOwnersConst['sessions:uncommitted']).toBe('orchestrator')
    expect(AppClientUiChannelOwnersConst['sessions:uncommitted-changed']).toBe('orchestrator')
    expect(OrchestratorChannelsConst).toHaveProperty('sessions:uncommitted', true)
    expect(AppClientUiBridgeEventsConst).toHaveProperty('onSessionsUncommittedChanged', 'sessions:uncommitted-changed')
  })

  it('answers the snapshot to a workspace window and refuses any other caller', async () => {
    handlers.clear()
    const workspace = Object.assign(new EventEmitter(), { isDestroyed: () => false })
    const stranger = Object.assign(new EventEmitter(), { isDestroyed: () => false })
    const snapshot = { revision: 3, sessions: { s1: { files: 2, sample: ['app/a.ts', 'docs/b.md'] } } }
    bindService(new ServiceSessionUncommittedIpc({ snapshot: () => snapshot },
      (caller) => callerSource(caller) === workspace ? 'window' : null)).initialize()

    expect([...handlers.keys()]).toEqual(Object.keys(ServiceSessionUncommittedIpc.channelsConst))
    expect(await handlers.get('sessions:uncommitted')!({ sender: workspace })).toEqual({ ok: true, value: snapshot })
    expect(await handlers.get('sessions:uncommitted')!({ sender: stranger }))
      .toEqual({ ok: false, error: 'The uncommitted mark was asked for by an unknown workspace' })
  })
})
