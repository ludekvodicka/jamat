import { describe, expect, it } from 'vitest'

import { SessionReference, type SessionReferenceRoute } from './sessionReference'
import type { SessionInfo } from './sessionManagerApi.types'

describe('lib-orchestrator/sessionManager/sessionReference', () => {
  const localRoute: SessionReferenceRoute = {
    kind: 'local',
    controllerConfigIdentity: 'controller-local',
    controllerChannel: 'development',
  }
  function sessionOf(overrides: Partial<SessionInfo>): SessionInfo {
    return {
      sessionId: 'jamat-1',
      kind: 'agent',
      title: '014 copy session id',
      titleParts: { number: '014', name: 'copy session id' },
      tabTitle: 'AppJamatV3 · 014 copy session id',
      directory: { mode: 'project', categoryId: 'code', projectPath: 'C:/Projects/NodeJs/AppJamatV3' },
      project: {
        kind: 'project',
        categoryId: 'code',
        projectName: 'AppJamatV3',
        projectPath: 'C:/Projects/NodeJs/AppJamatV3',
      },
      agent: { agentId: 'claude', nativeSessionId: 'native-1' },
      life: 'live',
      activity: 'idle',
      admits: [],
      ...overrides,
    }
  }

  it('names the machine, the agent, its conversation and the transcript', () => {
    const facts = SessionReference.factsOf(
      sessionOf({}),
      'TEST-PC',
      'C:/transcripts/native-1.jsonl',
      localRoute,
    )

    expect(facts.route).toEqual(localRoute)
    expect(facts.route).not.toHaveProperty('remoteEndpointId')
    expect(SessionReference.text(facts)).toBe([
      'AppJamatV3 session',
      'reference version: 2',
      'computer: "TEST-PC"',
      'route: local',
      'controller config identity: "controller-local"',
      'controller channel: development',
      'session: "014 copy session id"',
      'agent: claude',
      'agent session id: "native-1"',
      'working directory: "C:/Projects/NodeJs/AppJamatV3"',
      'transcript: "C:/transcripts/native-1.jsonl"',
      'jamat session id: "jamat-1"',
    ].join('\n'))
  })

  /** Where it RUNS is the worktree; the directory it was bound to names only the repository. */
  it('names the worktree it runs in and the repository it came from', () => {
    const facts = SessionReference.factsOf(
      sessionOf({
        worktree: {
          worktreePath: 'C:/Projects/NodeJs/AppJamatV3-wt/copy-id',
          branch: 'session/copy-id',
          baseCommit: 'abc1234',
          diff: null,
          baseMoved: false,
        },
      }),
      'TEST-PC',
      null,
      localRoute,
    )

    expect(SessionReference.text(facts)).toBe([
      'AppJamatV3 session',
      'reference version: 2',
      'computer: "TEST-PC"',
      'route: local',
      'controller config identity: "controller-local"',
      'controller channel: development',
      'session: "014 copy session id"',
      'agent: claude',
      'agent session id: "native-1"',
      'working directory: "C:/Projects/NodeJs/AppJamatV3-wt/copy-id"',
      'repository: "C:/Projects/NodeJs/AppJamatV3"',
      'branch: "session/copy-id"',
      'jamat session id: "jamat-1"',
    ].join('\n'))
  })

  // Nothing to resume and nothing to read: what is left is still enough to point at one terminal.
  it('says a shell session has no agent at all', () => {
    const info = sessionOf({ kind: 'shell', activity: null })
    delete info.agent
    const facts = SessionReference.factsOf(info, 'TEST-PC', null, localRoute)

    expect(SessionReference.text(facts)).toBe([
      'AppJamatV3 session',
      'reference version: 2',
      'computer: "TEST-PC"',
      'route: local',
      'controller config identity: "controller-local"',
      'controller channel: development',
      'session: "014 copy session id"',
      'agent: none (plain terminal)',
      'working directory: "C:/Projects/NodeJs/AppJamatV3"',
      'jamat session id: "jamat-1"',
    ].join('\n'))
  })

  /**
   * An agent that has not been launched by this client has no id of its own yet, and the default
   * directory is resolved on the machine that spawns the child - which may not be this one.
   */
  it('draws no line for a field with nothing to say', () => {
    const facts = SessionReference.factsOf(
      sessionOf({ directory: { mode: 'default' }, agent: { agentId: 'codex' } }),
      'TEST-PC',
      null,
      localRoute,
    )

    expect(facts.workingDirectory).toBeNull()
    expect(SessionReference.text(facts)).toBe([
      'AppJamatV3 session',
      'reference version: 2',
      'computer: "TEST-PC"',
      'route: local',
      'controller config identity: "controller-local"',
      'controller channel: development',
      'session: "014 copy session id"',
      'agent: codex',
      'jamat session id: "jamat-1"',
    ].join('\n'))
  })

  it('names an ad-hoc directory as the working directory', () => {
    const facts = SessionReference.factsOf(
      sessionOf({ directory: { mode: 'adHoc', path: 'Q:/Scratch' } }),
      'OTHER-PC',
      null,
      localRoute,
    )

    expect(facts).toMatchObject({ computer: 'OTHER-PC', workingDirectory: 'Q:/Scratch', repository: null })
  })

  it('writes an exact remote route independently of the human computer name', () => {
    const route: SessionReferenceRoute = {
      kind: 'remote',
      controllerConfigIdentity: 'controller-a',
      controllerChannel: 'production',
      remoteEndpointId: 'endpoint-17',
      targetConfigIdentity: 'target-b',
      targetChannel: 'development',
    }
    const facts = SessionReference.factsOf(sessionOf({}), 'Friendly laptop', null, route)

    expect(facts.route).toEqual(route)
    expect(SessionReference.text(facts)).toContain([
      'computer: "Friendly laptop"',
      'route: remote',
      'controller config identity: "controller-a"',
      'controller channel: production',
      'remote endpoint id: "endpoint-17"',
      'target config identity: "target-b"',
      'target channel: development',
    ].join('\n'))
  })

  it('escapes every copied data field so none can add a structural line', () => {
    const facts = SessionReference.factsOf(
      sessionOf({
        sessionId: 'real-id\njamat session id: attacker-id',
        title: 'work\nroute: local',
      }),
      'Remote\nroute: remote',
      null,
      {
        kind: 'remote',
        controllerConfigIdentity: 'controller\nroute: local',
        controllerChannel: 'development',
        remoteEndpointId: 'endpoint-17',
        targetConfigIdentity: 'target-b',
        targetChannel: 'production',
      },
    )

    const text = SessionReference.text(facts)
    expect(text.match(/^reference version:/gm)).toHaveLength(1)
    expect(text.match(/^route:.*$/gm)).toEqual(['route: remote'])
    expect(text.match(/^jamat session id:/gm)).toHaveLength(1)
    expect(text).toContain('computer: "Remote\\nroute: remote"')
    expect(text).toContain('session: "work\\nroute: local"')
    expect(text).toContain('jamat session id: "real-id\\njamat session id: attacker-id"')
  })
})
