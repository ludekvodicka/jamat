import { SessionsFilterState } from '../../../shared/sessionsFilterState'
import { describe, expect, it } from 'vitest'

import type {
  RemoteConnectionsSnapshot,
  RemoteInboundConnectionDto,
  RemoteOutboundEndpointDto,
} from '../../../../lib-orchestrator/remoteControl/remoteConnectionsApi.types'
import type {
  SessionInfo,
  SessionsSnapshot,
} from '../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { TerminalTargetCodec } from '../../../shared/terminalTarget'
import { RemoteSessionsTreeModel } from './remoteSessionsTreeModel'
import type { TreeNode } from './sessionsTreeModel'

describe('app-client-ui/renderer/views/sessionsTree/remoteSessionsTreeModel', () => {
  it('groups connected outbound endpoints by stable computer identity and omits offline profiles', () => {
    const remote = RemoteSessionsTreeFixtures.remote([
      RemoteSessionsTreeFixtures.outbound('profile-b', 'computer-a', 'endpoint-b', 'Workstation', null,
        'offline'),
      RemoteSessionsTreeFixtures.outbound('profile-a', 'computer-a', 'endpoint-a', 'Workstation',
        RemoteSessionsTreeFixtures.snapshot([
          RemoteSessionsTreeFixtures.session('same-session', 'Alpha'),
        ])),
    ])

    const result = RemoteSessionsTreeModel.build(
      remote,
      RemoteSessionsTreeFixtures.snapshot([]),
      RemoteSessionsTreeFixtures.view(),
      new Set(),
      new Map(),
    )

    expect(result.outbound).toHaveLength(1)
    expect(result.outbound[0]?.id).toBe('remote-computer:computer-a')
    expect(result.outbound[0]?.endpoints.map((entry) => [entry.remoteEndpointId, entry.status]))
      .toEqual([['endpoint-a', 'connected']])
  })

  it('adds only selected sessions with their category and project, and keeps them after a disconnect', () => {
    const sessions = RemoteSessionsTreeFixtures.snapshot([
      RemoteSessionsTreeFixtures.session('chosen', 'Alpha'),
      RemoteSessionsTreeFixtures.session('not-chosen', 'Beta'),
    ])
    const endpoint = RemoteSessionsTreeFixtures.outbound('profile', 'computer', 'endpoint', 'Computer', sessions)
    const build = (selectedSessionIds: string[], status: RemoteOutboundEndpointDto['status']) => RemoteSessionsTreeModel.build(
      RemoteSessionsTreeFixtures.remote([{ ...endpoint, selectedSessionIds, status }]),
      RemoteSessionsTreeFixtures.snapshot([]), RemoteSessionsTreeFixtures.view(), new Set(), new Map(),
    )
    expect(build([], 'connected').outbound).toEqual([])
    for (const status of ['connected', 'offline'] as const) {
      const tree = build(['chosen'], status)
      expect(tree.outbound).toHaveLength(1)
      expect(JSON.stringify(tree.outbound)).toContain('chosen')
      expect(JSON.stringify(tree.outbound)).not.toContain('not-chosen')
      expect(JSON.stringify(tree.outbound)).not.toContain('Beta')
    }
  })

  it('keeps identical session IDs from two endpoints distinct and strips local path operations', () => {
    const remote = RemoteSessionsTreeFixtures.remote([
      RemoteSessionsTreeFixtures.outbound('profile-a', 'computer-a', 'endpoint-a', 'Same name',
        RemoteSessionsTreeFixtures.snapshot([
          RemoteSessionsTreeFixtures.session('same-session', 'Alpha'),
        ])),
      RemoteSessionsTreeFixtures.outbound('profile-b', 'computer-b', 'endpoint-b', 'Same name',
        RemoteSessionsTreeFixtures.snapshot([
          RemoteSessionsTreeFixtures.session('same-session', 'Beta'),
        ])),
    ])

    const result = RemoteSessionsTreeModel.build(
      remote,
      RemoteSessionsTreeFixtures.snapshot([]),
      RemoteSessionsTreeFixtures.view(),
      new Set(),
      new Map(),
    )
    const left = RemoteSessionsTreeFixtures.sessionNode(result.outbound[0]?.endpoints[0]?.tree.nodes)
    const right = RemoteSessionsTreeFixtures.sessionNode(result.outbound[1]?.endpoints[0]?.tree.nodes)
    const project = RemoteSessionsTreeFixtures.projectNode(
      result.outbound[0]?.endpoints[0]?.tree.nodes,
    )
    const category = result.outbound[0]?.endpoints[0]?.tree.nodes[0]

    expect(result.outbound.map((computer) => computer.remoteComputerId))
      .toEqual(['computer-a', 'computer-b'])
    expect(left.id).not.toBe(right.id)
    expect(left.target).toEqual({
      kind: 'remote',
      remoteEndpointId: 'endpoint-a',
      sessionId: 'same-session',
    })
    expect(right.target).toEqual({
      kind: 'remote',
      remoteEndpointId: 'endpoint-b',
      sessionId: 'same-session',
    })
    expect(left.operationScope).toBe('remote')
    expect(left.actions).toEqual(['finalize'])
    expect(project).toMatchObject({ launch: null, folderSessionId: null })
    expect(category).toMatchObject({ kind: 'category', categoryId: null })
  })

  /**
   * The connected-only rule, pinned rather than merely implemented.
   *
   * Drawing the other three states here is the obvious change to make - the snapshot carries them,
   * each one has a reason, and a greyed row would say "this computer exists". It was decided
   * against: the tree is what is running now, and a computer that is not connected is a settings
   * matter. Settings -> Remote Control lists every paired computer with its last success, its next
   * retry, its version and a manual Retry. Whoever comes to add rows here should change that
   * decision first, not this test.
   */
  it.each([
    ['connecting', 'connecting'],
    ['offline', 'offline'],
    ['idle', 'idle'],
  ] as const)('draws no row at all for a computer that is %s', (_name, status) => {
    const remote = RemoteSessionsTreeFixtures.remote([
      RemoteSessionsTreeFixtures.outbound('profile-a', 'computer-a', 'endpoint-a', 'Workstation',
        // Sessions and diagnosis both: what is left out is left out however much of it there is.
        RemoteSessionsTreeFixtures.snapshot([
          RemoteSessionsTreeFixtures.session('session-a', 'Still listed'),
        ]), status),
    ])

    const result = RemoteSessionsTreeModel.build(
      remote,
      RemoteSessionsTreeFixtures.snapshot([]),
      RemoteSessionsTreeFixtures.view(),
      new Set(),
      new Map(),
    )

    expect(result.outbound).toEqual([])
    expect(result.previous.size).toBe(0)
  })

  it('keeps the connected computer of a pair whose other endpoints are not', () => {
    const remote = RemoteSessionsTreeFixtures.remote([
      RemoteSessionsTreeFixtures.outbound('profile-a', 'computer-a', 'endpoint-a', 'Workstation',
        RemoteSessionsTreeFixtures.snapshot([
          RemoteSessionsTreeFixtures.session('session-a', 'Alpha'),
        ])),
      RemoteSessionsTreeFixtures.outbound('profile-b', 'computer-a', 'endpoint-b', 'Workstation',
        null, 'offline'),
    ])

    const result = RemoteSessionsTreeModel.build(
      remote,
      RemoteSessionsTreeFixtures.snapshot([]),
      RemoteSessionsTreeFixtures.view(),
      new Set(),
      new Map(),
    )

    expect(result.outbound.map((computer) => computer.endpoints.map((entry) =>
      entry.remoteEndpointId))).toEqual([['endpoint-a']])
  })

  it('keeps marks and active filtering scoped to the remote endpoint', () => {
    const remote = RemoteSessionsTreeFixtures.remote([
      RemoteSessionsTreeFixtures.outbound('profile-a', 'computer-a', 'endpoint-a', 'A',
        RemoteSessionsTreeFixtures.snapshot([
          RemoteSessionsTreeFixtures.session('same-session', 'Alpha'),
        ])),
      RemoteSessionsTreeFixtures.outbound('profile-b', 'computer-b', 'endpoint-b', 'B',
        RemoteSessionsTreeFixtures.snapshot([
          RemoteSessionsTreeFixtures.session('same-session', 'Beta'),
        ])),
    ])
    const marked = TerminalTargetCodec.key({
      kind: 'remote', remoteEndpointId: 'endpoint-a', sessionId: 'same-session',
    })
    const active = TerminalTargetCodec.key({
      kind: 'remote', remoteEndpointId: 'endpoint-b', sessionId: 'same-session',
    })

    const result = RemoteSessionsTreeModel.build(
      remote,
      RemoteSessionsTreeFixtures.snapshot([]),
      {
        ...RemoteSessionsTreeFixtures.view(),
        filters: { ...SessionsFilterState.allConst, states: ['attention'] },
        inFront: new Set([active]),
      },
      new Set([marked]),
      new Map(),
    )
    const left = RemoteSessionsTreeFixtures.sessionNode(result.outbound[0]?.endpoints[0]?.tree.nodes)
    const right = RemoteSessionsTreeFixtures.sessionNode(result.outbound[1]?.endpoints[0]?.tree.nodes)
    expect(left.badges.attention).toBe(true)
    expect(right.badges.attention).toBe(false)
  })

  it('shows only locally attached inbound sessions and keeps one branch per peer', () => {
    const local = RemoteSessionsTreeFixtures.snapshot([
      RemoteSessionsTreeFixtures.session('shared-session', 'Shared'),
      RemoteSessionsTreeFixtures.session('not-attached', 'Hidden'),
    ])
    const remote = RemoteSessionsTreeFixtures.remote([], [
      RemoteSessionsTreeFixtures.inbound('connection-a', 'computer-a', 'endpoint-a',
        ['shared-session']),
      RemoteSessionsTreeFixtures.inbound('connection-b', 'computer-b', 'endpoint-b',
        ['shared-session']),
    ])

    const result = RemoteSessionsTreeModel.build(
      remote,
      local,
      RemoteSessionsTreeFixtures.view(),
      new Set(),
      new Map(),
    )
    const left = RemoteSessionsTreeFixtures.sessionNode(result.inbound[0]?.endpoints[0]?.tree.nodes)
    const right = RemoteSessionsTreeFixtures.sessionNode(result.inbound[1]?.endpoints[0]?.tree.nodes)

    expect(result.inbound).toHaveLength(2)
    expect(left.target).toEqual({ kind: 'local', sessionId: 'shared-session' })
    expect(right.target).toEqual({ kind: 'local', sessionId: 'shared-session' })
    expect(left.id).not.toBe(right.id)
    expect(RemoteSessionsTreeFixtures.sessionIds(result.inbound[0]?.endpoints[0]?.tree.nodes))
      .toEqual(['shared-session'])
  })

  it('keeps an inbound connection visible when it has no active attach', () => {
    const remote = RemoteSessionsTreeFixtures.remote([], [
      RemoteSessionsTreeFixtures.inbound('connection-a', 'computer-a', 'endpoint-a', []),
    ])

    const result = RemoteSessionsTreeModel.build(
      remote,
      RemoteSessionsTreeFixtures.snapshot([
        RemoteSessionsTreeFixtures.session('session-a', 'Local'),
      ]),
      RemoteSessionsTreeFixtures.view(),
      new Set(),
      new Map(),
    )

    expect(result.inbound).toHaveLength(1)
    expect(result.inbound[0]?.endpoints[0]?.tree.emptyState).toBe('noSessions')
  })
})

class RemoteSessionsTreeFixtures {
  static readonly nowConst = 1_754_400_000_000

  static view() {
    return {
      filters: SessionsFilterState.allConst,
      filterText: '',
      inFront: new Set<string>(),
      now: RemoteSessionsTreeFixtures.nowConst,
    }
  }

  static remote(
    outbound: readonly RemoteOutboundEndpointDto[],
    inbound: readonly RemoteInboundConnectionDto[] = [],
  ): RemoteConnectionsSnapshot {
    return { revision: 1, outbound, inbound }
  }

  static outbound(
    profileId: string,
    remoteComputerId: string,
    remoteEndpointId: string,
    displayName: string,
    sessions: SessionsSnapshot | null,
    status: RemoteOutboundEndpointDto['status'] = 'connected',
  ): RemoteOutboundEndpointDto {
    return {
      profileId,
      remoteComputerId,
      remoteEndpointId,
      configIdentity: `config-${remoteEndpointId}`,
      runtimeChannel: 'development',
      displayName,
      endpoint: { host: '127.0.0.1', port: 47_150 },
      status,
      error: null,
      // Filled in as the connector fills them: a computer that has been reached knows when, and one
      // that is waiting knows when the next dial is due. The tree draws none of it, which is what
      // the pin below is about.
      lastConnectedAt: status === 'connected' ? 1_700_000_000_000 : null,
      nextRetryAt: status === 'offline' ? 1_700_000_030_000 : null,
      applicationVersion: status === 'connected' ? '2026.08.31.10.00' : null,
      optionalOperations: status === 'connected' ? ['sessions.transcript'] : null,
      connectionId: status === 'connected' ? `connection-${profileId}` : null,
      sessions,
      selectedSessionIds: status === 'connected' ? sessions?.sessions.map((session) => session.sessionId) ?? [] : [],
    }
  }

  static inbound(
    connectionId: string,
    remoteComputerId: string,
    remoteEndpointId: string,
    activeSessionIds: readonly string[],
  ): RemoteInboundConnectionDto {
    return {
      connectionId,
      connectedAt: 1,
      identity: {
        remoteComputerId,
        remoteEndpointId,
        configIdentity: `config-${remoteEndpointId}`,
        runtimeChannel: 'development',
        displayName: `Computer ${remoteComputerId}`,
      },
      activeSessionIds,
    }
  }

  static snapshot(sessions: SessionInfo[]): SessionsSnapshot {
    return {
      revision: 1,
      reconciled: true,
      host: {
        presence: 'running',
        hostVersion: 'test',
        hostInstanceId: 'host',
        liveCount: sessions.filter((session) => session.life === 'live').length,
        lastStartError: null,
      },
      categories: [{ id: 'nodejs', label: 'NodeJS', path: 'C:\\Projects\\NodeJs' }],
      sessions,
      orphans: [],
    }
  }

  static session(sessionId: string, title: string): SessionInfo {
    return {
      sessionId,
      kind: 'agent',
      title,
      titleParts: { number: null, name: title },
      tabTitle: `AppJamatV3 - ${title}`,
      directory: {
        mode: 'project',
        categoryId: 'nodejs',
        projectPath: 'C:\\Projects\\NodeJs\\AppJamatV3',
      },
      project: {
        kind: 'project',
        categoryId: 'nodejs',
        projectName: 'AppJamatV3',
        projectPath: 'C:\\Projects\\NodeJs\\AppJamatV3',
      },
      agent: { agentId: 'codex' },
      life: 'live',
      activity: 'waiting',
      admits: ['finalize'],
    }
  }

  static sessionNode(nodes: readonly TreeNode[] | undefined): Extract<TreeNode, { kind: 'session' }> {
    const found = RemoteSessionsTreeFixtures.flatten(nodes ?? [])
      .find((node): node is Extract<TreeNode, { kind: 'session' }> => node.kind === 'session')
    if (!found) throw new Error('No session node')
    return found
  }

  static projectNode(nodes: readonly TreeNode[] | undefined): Extract<TreeNode, { kind: 'project' }> {
    const found = RemoteSessionsTreeFixtures.flatten(nodes ?? [])
      .find((node): node is Extract<TreeNode, { kind: 'project' }> => node.kind === 'project')
    if (!found) throw new Error('No project node')
    return found
  }

  static sessionIds(nodes: readonly TreeNode[] | undefined): readonly string[] {
    return RemoteSessionsTreeFixtures.flatten(nodes ?? [])
      .filter((node): node is Extract<TreeNode, { kind: 'session' }> => node.kind === 'session')
      .map((node) => node.sessionId)
  }

  private static flatten(nodes: readonly TreeNode[]): readonly TreeNode[] {
    return nodes.flatMap((node) => [node, ...RemoteSessionsTreeFixtures.flatten(node.children)])
  }
}
