import { describe, expect, it } from 'vitest'

import type { WorkspacePanelPresence } from '../../shared/tabTransfer'
import { TerminalTargetCodec } from '../../shared/terminalTarget'
import { WorkspacePanelIndex } from './workspacePanelIndex'

describe('app-client-ui/app/tabs/workspacePanelIndex', () => {
  function panel(
    panelId: string,
    sessionId: string | null = null,
    presentation: WorkspacePanelPresence['presentation'] = null,
  ): WorkspacePanelPresence {
    return {
      panelId,
      key: sessionId === null ? 'probe' : 'terminal',
      title: panelId,
      params: sessionId === null ? {} : { sessionId },
      sessionId,
      presentation,
    }
  }

  function remotePanel(
    panelId: string,
    remoteEndpointId: string,
    sessionId: string,
  ): WorkspacePanelPresence {
    return {
      panelId,
      key: 'terminal',
      title: panelId,
      params: { target: { kind: 'remote', remoteEndpointId, sessionId } },
      sessionId: null,
      presentation: null,
    }
  }

  it('grants an idempotent claim to its owner and reports the owner to another window', () => {
    const index = new WorkspacePanelIndex()
    expect(index.claimOpen('one', panel('probe:1'))).toEqual({ kind: 'granted' })
    expect(index.claimOpen('one', panel('probe:1'))).toEqual({ kind: 'granted' })

    expect(index.claimOpen('two', panel('probe:1'))).toEqual({
      kind: 'owned',
      windowId: 'one',
      panelId: 'probe:1',
    })
    expect(index.entries()).toEqual([{ panelId: 'probe:1', windowId: 'one' }])
  })

  it('refreshes what it holds when the same window claims the panel again', () => {
    const index = new WorkspacePanelIndex()
    index.claimOpen('main', panel('terminal:1', 'session-1'))

    expect(index.claimOpen('main', { ...panel('terminal:1', 'session-1'), title: 'Renamed' }))
      .toEqual({ kind: 'granted' })

    expect(index.snapshot().map((entry) => entry.title)).toEqual(['Renamed'])
  })

  it('allows only one session presentation while plain panels collide only by panel id', () => {
    const index = new WorkspacePanelIndex()
    index.claimOpen('one', panel('terminal:regular-1', 'session-1', 'session'))

    expect(index.claimOpen('two', panel('terminal:regular-2', 'session-1', 'session')))
      .toEqual({ kind: 'owned', windowId: 'one', panelId: 'terminal:regular-1' })
    expect(index.claimOpen('two', panel('terminal:plain-1', 'session-1', 'plain')))
      .toEqual({ kind: 'granted' })
    expect(index.claimOpen('three', panel('terminal:plain-2', 'session-1', 'plain')))
      .toEqual({ kind: 'granted' })
  })

  it('deduplicates a remote target while keeping the same session id distinct across endpoints', () => {
    const index = new WorkspacePanelIndex()
    const first = remotePanel('remote-a', 'endpoint-a', 'same-session')
    const duplicate = remotePanel('remote-a-copy', 'endpoint-a', 'same-session')
    const second = remotePanel('remote-b', 'endpoint-b', 'same-session')
    index.claimOpen('one', first)

    expect(index.claimOpen('two', duplicate))
      .toEqual({ kind: 'owned', windowId: 'one', panelId: 'remote-a' })
    expect(index.claimOpen('two', second)).toEqual({ kind: 'granted' })
    index.setActivePanel('one', 'remote-a')
    index.setActivePanel('two', 'remote-b')

    const firstKey = TerminalTargetCodec.key({
      kind: 'remote', remoteEndpointId: 'endpoint-a', sessionId: 'same-session',
    })
    const secondKey = TerminalTargetCodec.key({
      kind: 'remote', remoteEndpointId: 'endpoint-b', sessionId: 'same-session',
    })
    expect(index.panelsOfTerminalTarget(firstKey)).toEqual([{ windowId: 'one', panel: first }])
    expect(index.visibleTerminalTargetKeys(new Set(['one', 'two'])))
      .toEqual([firstKey, secondKey])
  })

  it('lets the first reconcile win and rejects later copies in bulk', () => {
    const index = new WorkspacePanelIndex()
    expect(index.reconcile('one', [
      panel('probe:1'),
      panel('terminal:1', 'session-1', 'session'),
    ])).toEqual({
      acceptedPanelIds: ['probe:1', 'terminal:1'],
      rejectedPanelIds: [],
    })

    expect(index.reconcile('two', [
      panel('probe:1'),
      panel('terminal:2', 'session-1', 'session'),
      panel('probe:2'),
    ])).toEqual({
      acceptedPanelIds: ['probe:2'],
      rejectedPanelIds: ['probe:1', 'terminal:2'],
    })
  })

  it('releases only from the current owner and clears a whole renderer generation', () => {
    const index = new WorkspacePanelIndex()
    index.claimOpen('one', panel('probe:1'))
    index.claimOpen('one', panel('probe:2'))
    index.claimOpen('two', panel('probe:3'))

    index.release('probe:1', 'two')
    index.release('probe:2', 'one')
    index.releaseWindow('one')

    expect(index.entries()).toEqual([{ panelId: 'probe:3', windowId: 'two' }])
  })

  it('moves a panel from its expected owner and can recover one whose source vanished', () => {
    const index = new WorkspacePanelIndex()
    const live = panel('probe:1')
    index.claimOpen('one', live)
    index.transfer('one', 'two', live)
    expect(index.ownerOf('probe:1')).toBe('two')

    const vanished = panel('probe:2')
    index.transfer('gone', 'two', vanished)
    expect(index.ownerOf('probe:2')).toBe('two')
    expect(() => index.transfer('one', 'three', live)).toThrow(/different owner/)
  })

  it('keeps the transferred id while replacing its indexed payload with live parameters', () => {
    const index = new WorkspacePanelIndex()
    const original = panel('terminal:stable-id', 'session-1', 'session')
    index.claimOpen('one', original)
    const transferred = {
      ...original,
      title: 'Renamed',
      params: { sessionId: 'session-1', sidebar: { width: 360 } },
    }

    index.transfer('one', 'two', transferred)

    expect(index.panelsOfSession('session-1')).toEqual([
      { windowId: 'two', panel: transferred },
    ])
    expect(index.ownerOf('terminal:stable-id')).toBe('two')
  })

  it('reports session presence, plain sessions and active sessions in visible windows', () => {
    const index = new WorkspacePanelIndex()
    index.claimOpen('main', panel('regular', 'session-1', 'session'))
    index.claimOpen('holder', panel('plain', 'session-2', 'plain'))
    index.claimOpen('hidden', panel('other', 'session-3', 'session'))
    index.setActivePanel('main', 'regular')
    index.setActivePanel('holder', 'plain')
    index.setActivePanel('hidden', 'other')

    expect(index.openSessionIds()).toEqual(['session-1', 'session-2', 'session-3'])
    expect(index.plainSessionIds('holder')).toEqual(['session-2'])
    expect(index.panelsOfSession('session-1')).toEqual([
      { windowId: 'main', panel: panel('regular', 'session-1', 'session') },
    ])
    expect(index.visibleTerminalTargetKeys(new Set(['main', 'holder']))).toEqual([
      'session-1',
      'session-2',
    ])
  })

  it('refuses to mark a foreign or unknown panel active', () => {
    const index = new WorkspacePanelIndex()
    index.claimOpen('one', panel('probe:1'))

    expect(() => index.setActivePanel('two', 'probe:1')).toThrow(/not owned/)
    expect(() => index.setActivePanel('one', 'missing')).toThrow(/not owned/)
  })

  it('returns every panel field with its owner and active flag', () => {
    const index = new WorkspacePanelIndex()
    const terminal = {
      ...panel('terminal:session-1', 'session-1', 'session'),
      title: 'Project - 001',
      params: { sessionId: 'session-1', nested: { value: 1 } },
    }
    index.claimOpen('main', terminal)
    index.claimOpen('holder', panel('probe:1'))
    index.setActivePanel('main', terminal.panelId)

    expect(index.snapshot()).toEqual([
      {
        panelId: 'terminal:session-1',
        windowId: 'main',
        key: 'terminal',
        title: 'Project - 001',
        params: { sessionId: 'session-1', nested: { value: 1 } },
        sessionId: 'session-1',
        presentation: 'session',
        active: true,
      },
      {
        panelId: 'probe:1',
        windowId: 'holder',
        key: 'probe',
        title: 'probe:1',
        params: {},
        sessionId: null,
        presentation: null,
        active: false,
      },
    ])
    expect(index.snapshot()[0]?.params).not.toBe(terminal.params)
  })
})
