import { CommitOpenStore } from '../../versioning/commitOpenStore'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  SessionActivity,
  SessionInfo,
  SessionsOpResult,
  SessionsSnapshot,
} from '../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type {
  RemoteConnectionsSnapshot,
} from '../../../../lib-orchestrator/remoteControl/remoteConnectionsApi.types'
import type { RemoteControlResponse } from '../../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type { IpcResult, LoadSessionsViewResult } from '../../../shared/appClientUiIpc'
import type { SessionsTabsView } from '../../../shared/sessionsViewState'
import type { SavedSessionsFilter } from '../../../shared/sessionsFilterState'
import { type TerminalTarget, TerminalTargetCodec } from '../../../shared/terminalTarget'
import { CommandRegistry } from '../../commands/commandRegistry'
import { SnapshotStore, type SnapshotStorePorts } from '../../ipc/snapshotStore'
import { SessionsMarksStore } from '../../sessions/sessionsMarksStore'
import { ActiveTerminalStore } from '../../shell/activeTerminalStore'
import type { TabSessionFacts } from '../../widgets/tabs/tabContextMenu'
import { SessionsFixtures } from '../../sessions/fixtures/sessionsFixtures'
import { SessionNodeState } from './sessionNodeState'
import {
  type SessionsTreePorts,
  type SessionsTreeRemotePorts,
  SessionsTreeView,
} from './sessionsTreeView'

describe('app-client-ui/renderer/views/sessionsTree/sessionsTreeView', () => {
  it('draws a red commit star for a clean session', async () => {
    const snapshot = SessionsFixtures.mixed()
    const sessionId = snapshot.sessions[0].sessionId
    await mount({ ...snapshot, sessions: snapshot.sessions.map((info) => ({ ...info, vcs: undefined })) }, null,
      { revision: 1, outbound: [], inbound: [] }, [], [sessionId])
    const star = await screen.findByLabelText('Commit dialog open')
    expect(star).toHaveClass('is-commit-open')
    expect(star).toHaveTextContent('*')
    const marker = screen.getByLabelText('Commit review required')
    expect(marker).toHaveAttribute('data-paint', 'danger')
    expect(marker).toHaveTextContent('!')
  })

  /** Every operation is recorded rather than performed, and every one answers the same way. */
  class Ports implements SessionsTreePorts, SnapshotStorePorts<SessionsSnapshot> {
    readonly calls: string[] = []
    readonly errors: string[] = []
    readonly savedViews: SessionsTabsView[] = []
    savedFilters: readonly SavedSessionsFilter[] = []
    filtersAnswer: IpcResult<boolean> = { ok: true, value: true }

    loadFilters(): Promise<IpcResult<readonly SavedSessionsFilter[]>> {
      return Promise.resolve({ ok: true, value: this.savedFilters })
    }

    saveFilters(filters: readonly SavedSessionsFilter[]): Promise<IpcResult<boolean>> {
      if (this.filtersAnswer.ok && this.filtersAnswer.value) this.savedFilters = filters
      return Promise.resolve(this.filtersAnswer)
    }
    answer: IpcResult<SessionsOpResult> = { ok: true, value: { ok: true, value: undefined } }
    /** Per call, where one answer for all of them is not enough. Keyed as `verb:sessionId`. */
    readonly answers = new Map<string, IpcResult<SessionsOpResult>>()
    /** What the store holds before this panel is drawn; null is a client that never stored one. */
    storedView: SessionsTabsView | null = null
    private changed: (() => void) | null = null
    /** Held answers, for the tests that are about the window while a call is still out. */
    private held: (() => void)[] | null = null

    constructor(private snapshot: SessionsSnapshot) {}

    loadView(): Promise<IpcResult<LoadSessionsViewResult>> {
      return Promise.resolve({ ok: true, value: { sessionsView: this.storedView } })
    }

    saveView(view: SessionsTabsView): Promise<IpcResult<boolean>> {
      this.savedViews.push(view)
      return Promise.resolve({ ok: true, value: true })
    }

    read(): Promise<IpcResult<SessionsSnapshot>> {
      return Promise.resolve({ ok: true, value: this.snapshot })
    }

    subscribe(onChanged: () => void): () => void {
      this.changed = onChanged
      return () => {
        this.changed = null
      }
    }

    /** What the main process does: swap the document, then say that something moved. */
    push(next: SessionsSnapshot): void {
      this.snapshot = next
      this.changed?.()
    }

    reportError(message: string): void {
      this.errors.push(message)
    }

    finalize(sessionId: string): Promise<IpcResult<SessionsOpResult>> {
      return this.record(`finalize:${sessionId}`)
    }

    remove(sessionId: string): Promise<IpcResult<SessionsOpResult>> {
      return this.record(`remove:${sessionId}`)
    }

    retrySetup(sessionId: string, acknowledgeSetup?: string): Promise<IpcResult<SessionsOpResult>> {
      // The hash is IN the call name: whether the answer was carried back is the whole test.
      return this.record(acknowledgeSetup === undefined
        ? `retrySetup:${sessionId}`
        : `retrySetup:${sessionId}:${acknowledgeSetup}`)
    }

    adoptOrphan(runtimeSessionId: string): Promise<IpcResult<SessionsOpResult>> {
      return this.record(`adoptOrphan:${runtimeSessionId}`)
    }

    /** Nothing answers until `release` is called: the window a second click would land in. */
    hold(): void {
      this.held = []
    }

    release(): void {
      const waiting = this.held ?? []
      this.held = null
      for (const resolve of waiting) resolve()
    }

    private record(call: string): Promise<IpcResult<SessionsOpResult>> {
      this.calls.push(call)
      const answer = this.answers.get(call) ?? this.answer
      const held = this.held
      if (held === null) return Promise.resolve(answer)
      return new Promise((resolve) => held.push(() => resolve(answer)))
    }
  }

  const stops: (() => void)[] = []

  afterEach(() => {
    cleanup()
    for (const stop of stops.splice(0))
      stop()
  })

  async function mount(
    snapshot: SessionsSnapshot,
    storedView: SessionsTabsView | null = null,
    initialRemote: RemoteConnectionsSnapshot = { revision: 1, outbound: [], inbound: [] },
    storedFilters: readonly SavedSessionsFilter[] = [],
    commitSessionIds: string[] = [],
  ) {
    const ports = new Ports(snapshot)
    ports.storedView = storedView
    ports.savedFilters = storedFilters
    const onLaunch = vi.fn()
    const onOpenSettings = vi.fn()
    const onOpenTerminal = vi.fn()
    const onCloseTerminal = vi.fn()
    const onRerunTerminal = vi.fn()
    const onFinalizeAsk = vi.fn()
    const onFocusTerminal = vi.fn()
    const commands = new CommandRegistry()
    /**
     * What the shell would answer about any session: canned facts that admit everything, with the
     * one thing the menu branches on read off the snapshot itself - a stopped session gets `Resume
     * session` where a live one gets `Restart session`, and a canned `false` drew the wrong one.
     */
    const sessionFacts = (sessionId: string): TabSessionFacts | null => {
      const life = snapshot.sessions.find((one) => one.sessionId === sessionId)?.life
      return {
        agentId: 'claude',
        color: null,
        directoryPath: 'C:/Projects/NodeJs/AppJamatV3',
        live: life === 'live',
        ended: life === 'ended' || life === 'lost',
        admits: ['newBeside', 'fork', 'restart', 'compact'],
      }
    }
    const snapshotStore = new SnapshotStore<SessionsSnapshot>('The sessions snapshot', ports)
    stops.push(snapshotStore.start())
    let remote = initialRemote
    let remoteChanged: (() => void) | null = null
    const remoteCalls: string[] = []
    const remoteAnswer = (
      operation: 'sessions.reopen' | 'sessions.finalize',
    ): IpcResult<RemoteControlResponse> => ({
      ok: true,
      value: {
        // The literal rather than the class: this is the web program, which takes nothing
        // out of the library but types (`CLAUDE.md` rule 1). `RemoteControlResponse`
        // types the field as that exact literal, so a wrong one here is a compile error.
        protocol: 'appjamat-v3-control.v1',
        requestId: 'test-request',
        operation,
        operationId: 'test-operation',
        ok: true,
        value: { sessionId: 'test-session' },
      },
    })
    const remotePorts: SessionsTreeRemotePorts & SnapshotStorePorts<RemoteConnectionsSnapshot> = {
      disconnect: (endpointId, sessionIds) => {
        remoteCalls.push(`disconnect:${endpointId}:${sessionIds?.join(',') ?? 'all'}`)
        return Promise.resolve({ ok: true, value: undefined })
      },
      read: () => Promise.resolve({ ok: true, value: remote }),
      subscribe: (onChanged) => {
        remoteChanged = onChanged
        return () => { remoteChanged = null }
      },
      reportError: (message) => ports.reportError(message),
      reopen: (remoteEndpointId, sessionId) => {
        remoteCalls.push(`reopen:${remoteEndpointId}:${sessionId}`)
        return Promise.resolve(remoteAnswer('sessions.reopen'))
      },
      finalize: (remoteEndpointId, sessionId) => {
        remoteCalls.push(`finalize:${remoteEndpointId}:${sessionId}`)
        return Promise.resolve(remoteAnswer('sessions.finalize'))
      },
    }
    const remoteSnapshotStore = new SnapshotStore<RemoteConnectionsSnapshot>(
      'The remote connections snapshot',
      remotePorts,
    )
    stops.push(remoteSnapshotStore.start())
    const marks = new SessionsMarksStore(snapshotStore, remoteSnapshotStore)
    stops.push(marks.start())
    const commitOpen = new CommitOpenStore({ read: async () => ({ ok: true, value: { revision: 1, sessionIds: commitSessionIds } }), subscribe: () => () => undefined, reportError: vi.fn() })
    stops.push(commitOpen.start())
    const activeTerminal = new ActiveTerminalStore()
    const tree = (
      <SessionsTreeView
        side="left"
        viewKey="sessionsTree"
        width={260}
        ports={ports}
        snapshotStore={snapshotStore}
        remotePorts={remotePorts}
        remoteSnapshotStore={remoteSnapshotStore}
        commands={commands}
        sessionFacts={sessionFacts}
        marks={marks}
          commitOpen={commitOpen}
        activeTerminal={activeTerminal}
        onLaunch={onLaunch}
        onOpenSettings={onOpenSettings}
        onOpenTerminal={onOpenTerminal}
        onCloseTerminal={onCloseTerminal}
        onRerunTerminal={onRerunTerminal}
        onFinalizeAsk={onFinalizeAsk}
        onFocusTerminal={onFocusTerminal}
      />
    )
    const view = render(tree)
    await waitFor(() =>
      expect(view.container.querySelector('.jamat-sessions__session')).toBeTruthy())
    return {
      ports,
      commands,
      onLaunch,
      onOpenSettings,
      onOpenTerminal,
      onCloseTerminal,
      onRerunTerminal,
      onFinalizeAsk,
      onFocusTerminal,
      remoteCalls,
      container: view.container,
      lookAt: (activeSessionId: string | null) => act(() => activeTerminal.set(
        activeSessionId === null
          ? null
          : {
              panelId: `terminal:${JSON.stringify({ sessionId: activeSessionId })}`,
              target: { kind: 'local', sessionId: activeSessionId },
            },
      )),
      lookAtTarget: (target: TerminalTarget | null) => act(() => activeTerminal.set(
        target === null
          ? null
          : {
              panelId: `terminal:${JSON.stringify(TerminalTargetCodec.params(target))}`,
              target,
            },
      )),
      setVisibleTargets: (targetKeys: readonly string[]) => act(() =>
        marks.setActiveTargets(new Set(targetKeys))),
      pushRemote: (next: RemoteConnectionsSnapshot) => {
        remote = next
        remoteChanged?.()
      },
      unmount: view.unmount,
    }
  }

  function sessionOf(snapshot: SessionsSnapshot, sessionId: string): SessionInfo {
    const found = snapshot.sessions.find((session) => session.sessionId === sessionId)
    if (!found)
      throw new Error(`No fixture session ${sessionId}`)
    return found
  }

  function settled(
    snapshot: SessionsSnapshot,
    sessionId: string,
    life: 'ended' | 'lost',
    outcome: 'finished' | 'failed' | 'interrupted',
  ): SessionsSnapshot {
    return {
      ...snapshot,
      revision: snapshot.revision + 1,
      sessions: snapshot.sessions.map((session) => session.sessionId !== sessionId
        ? session
        : {
            ...session,
            life,
            outcome,
            activity: session.kind === 'agent' ? 'unknown' as const : null,
            admits: session.worktree === undefined
              ? session.admits
              : [...session.admits, 'discardWorktree' as const],
            endedAt: Date.now(),
            exitCode: outcome === 'failed' ? 1 : 0,
          }),
    }
  }

  function confirmFinish(container: HTMLElement, sessionId: string): void {
    fireEvent.click(actionNamed(container, sessionId, 'Finish'))
    fireEvent.click(actionNamed(container, sessionId, 'Finish?'))
  }

  function outboundEndpoint(
    sessions: SessionsSnapshot,
    remoteEndpointId: string,
    over: Partial<RemoteConnectionsSnapshot['outbound'][number]> = {},
  ): RemoteConnectionsSnapshot['outbound'][number] {
    return {
      profileId: `profile-${remoteEndpointId}`,
      remoteComputerId: 'computer-one',
      remoteEndpointId,
      configIdentity: `config-${remoteEndpointId}`,
      runtimeChannel: 'development',
      displayName: 'Office PC',
      endpoint: { host: '127.0.0.1', port: 47_150 },
      status: 'connected',
      error: null,
      lastConnectedAt: null,
      nextRetryAt: null,
      applicationVersion: null,
      optionalOperations: null,
      connectionId: `connection-${remoteEndpointId}`,
      sessions,
      selectedSessionIds: sessions.sessions.map((session) => session.sessionId),
      ...over,
    }
  }

  function inboundConnection(
    activeSessionIds: readonly string[] = [],
  ): RemoteConnectionsSnapshot['inbound'][number] {
    return {
      connectionId: 'inbound-connection',
      connectedAt: 1,
      identity: {
        remoteComputerId: 'controller-one',
        remoteEndpointId: 'controller-endpoint',
        configIdentity: 'controller-config',
        runtimeChannel: 'development',
        displayName: 'Controller PC',
      },
      activeSessionIds,
    }
  }

  function remoteSnapshot(
    outbound: RemoteConnectionsSnapshot['outbound'],
    inbound: RemoteConnectionsSnapshot['inbound'] = [],
    revision = 1,
  ): RemoteConnectionsSnapshot {
    return { revision, outbound, inbound }
  }

  function buttonNamed(root: ParentNode, label: string): HTMLElement {
    const found = [...root.querySelectorAll('button')].find((node) => node.textContent === label)
    if (!found)
      throw new Error(`No button reads ${JSON.stringify(label)} in ${root.textContent}`)
    return found
  }

  /**
   * By accessible name, which is what tells the project rows apart: their visible words are the
   * header buttons' words, and only the name says which project they would start in.
   */
  function labelled(root: ParentNode, label: string): HTMLElement {
    const found = namesIn(root).find(([name]) => name === label)
    if (!found)
      throw new Error(`No button is named ${JSON.stringify(label)} among ${
        JSON.stringify(namesIn(root).map(([name]) => name))}`)
    return found[1]
  }

  /**
   * Read by iteration rather than by an attribute selector: jsdom's selector engine does not match a
   * value that opens with `+`, and every launch button's name does.
   */
  function namesIn(root: ParentNode): [string, HTMLElement][] {
    return [...root.querySelectorAll('button')]
      .flatMap((node) => {
        const name = node.getAttribute('aria-label')
        return name === null ? [] : [[name, node] as [string, HTMLElement]]
      })
  }

  /**
   * The group row a label reads, the first of it: the tabs tree below draws the same project rows
   * again, and the sessions tree is the one above.
   */
  function groupRowLabelled(container: HTMLElement, label: string): HTMLElement {
    const found = [...container.querySelectorAll('.jamat-sessions__group-row')]
      .find((row) => row.querySelector('.jamat-sessions__label')?.textContent === label)
    if (!(found instanceof HTMLElement))
      throw new Error(`The tree drew no group row labelled ${JSON.stringify(label)}`)
    return found
  }

  function menuTitles(): string[] {
    return [...document.querySelectorAll(
      '.jamat-tab-menu > .jamat-context-menu__row > .jamat-context-menu__item',
    )].map((item) => item.querySelector('.jamat-context-menu__label')?.textContent ?? '')
  }

  function clickMenuItem(title: string): void {
    const found = [...document.querySelectorAll('.jamat-tab-menu .jamat-context-menu__label')]
      .find((label) => label.textContent === title)
    if (!(found instanceof HTMLElement))
      throw new Error(`The menu shows no item titled ${JSON.stringify(title)} in ${
        JSON.stringify(menuTitles())}`)
    fireEvent.click(found)
  }

  function chooseSessionMenuAction(container: HTMLElement, sessionId: string, title: string): void {
    fireEvent.contextMenu(rowOf(container, sessionId))
    clickMenuItem(title)
  }

  /** The row's OWN actions: a child combinator, so an install's buttons stay the install's. */
  function actionNamed(container: HTMLElement, sessionId: string, label: string): HTMLElement {
    const actions = rowOf(container, sessionId).querySelector('.jamat-sessions__actions')
    if (!actions)
      throw new Error(`No session row ${sessionId} in ${container.textContent}`)
    return buttonNamed(actions, label)
  }

  /** Every inline action a row draws, in order. */
  function labelsOf(container: HTMLElement, sessionId: string): string[] {
    const actions = rowOf(container, sessionId).querySelector('.jamat-sessions__actions')
    if (!actions)
      throw new Error(`No session row ${sessionId} in ${container.textContent}`)
    return [...actions.querySelectorAll('button')].map((node) => node.textContent ?? '')
  }

  function showAll(container: HTMLElement): void {
    fireEvent.click(buttonNamed(container, 'Filter'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'All' }))
  }

  function filterBy(container: HTMLElement, group: string, choice: string): void {
    fireEvent.click(buttonNamed(container, 'Filter'))
    fireEvent.click(screen.getByRole('menuitem', { name: group }))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: choice }))
    fireEvent.keyDown(window, { key: 'Escape' })
  }

  it('combines multiple colors and states with type, and clears every condition on right-click All', async () => {
    const mixed = SessionsFixtures.mixed()
    const { container } = await mount({ ...mixed, sessions: mixed.sessions.map((session) => ({
      ...session, color: session.sessionId === 's-working' ? 'red' : 'blue',
    })) })
    expect(screen.queryByRole('group', { name: 'Saved session filters' })).toBeNull()
    expect(container.querySelector('[data-session="s-done"]')).toBeNull()
    filterBy(container, 'Filter by color', 'Red')
    expect(container.querySelectorAll('[data-session]')).toHaveLength(1)
    fireEvent.click(buttonNamed(container, 'Filter'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Filter by color' }))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Blue' }))
    expect(screen.getByRole('menuitemcheckbox', { name: 'Red' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('menuitemcheckbox', { name: 'Blue' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.keyDown(window, { key: 'Escape' })
    filterBy(container, 'Filter by state', 'Running')
    filterBy(container, 'Filter by state', 'Question')
    filterBy(container, 'Filter by type', 'Codex')
    expect(container.querySelectorAll('[data-session]')).toHaveLength(1)
    expect(container.querySelector('[data-session="s-waiting"]')).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter sessions' }), { target: { value: 'no match' } })
    expect(container.querySelectorAll('[data-session]')).toHaveLength(0)
    fireEvent.click(buttonNamed(container, 'Filter'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Filter by color' }))
    fireEvent.contextMenu(screen.getByRole('menuitemcheckbox', { name: 'All' }))
    expect(screen.getByRole('textbox', { name: 'Filter sessions' }).getAttribute('value')).toBe('')
    expect(container.querySelectorAll('[data-session]')).toHaveLength(mixed.sessions.length)
  })

  it('opens on the conditions and keeps the two shortcuts below them', async () => {
    const hour = 60 * 60 * 1_000
    const mixed = SessionsFixtures.mixed()
    // The one session that closed just now. Every other end time in the fixtures is long past, so
    // the window is what decides this row rather than the filter simply showing everything ended.
    const sessions = mixed.sessions.map((session) => session.sessionId === 's-done'
      ? { ...session, endedAt: Date.now() - hour }
      : session)
    const { container } = await mount({ ...mixed, sessions })
    // `s-done` is finished, which is what the default filter hides.
    expect(container.querySelector('[data-session="s-done"]')).toBeNull()

    fireEvent.click(buttonNamed(container, 'Filter'))
    const menu = screen.getByRole('menu', { name: 'Session filters' })
    expect([...menu.querySelectorAll(':scope > .jamat-context-menu__row > button')]
      .map((item) => item.querySelector('.jamat-context-menu__label')?.textContent))
      .toEqual(['Filter by color', 'Filter by state', 'Filter by type', 'All', 'Last 6h closed', 'Save filter…'])

    fireEvent.change(screen.getByRole('textbox', { name: 'Filter sessions' }), { target: { value: 'Beta' } })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Last 6h closed' }))
    // The shortcut stands for a whole filter, so the search box goes with it - a word left behind
    // would hide the rows it was asked to show.
    expect(screen.getByRole('textbox', { name: 'Filter sessions' }).getAttribute('value')).toBe('')
    expect(container.querySelectorAll('[data-session]')).toHaveLength(1)
    expect(container.querySelector('[data-session="s-done"]')).toBeTruthy()
  })

  it('saves the current search, restores its chip after remount, and deletes it from either menu', async () => {
    const first = await mount(SessionsFixtures.mixed())
    filterBy(first.container, 'Filter by state', 'Question')
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter sessions' }), { target: { value: 'Beta' } })
    fireEvent.click(buttonNamed(first.container, 'Filter'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save filter…' }))
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Filter name' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter name' }), { target: { value: 'Questions' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(first.ports.savedFilters).toHaveLength(1))
    expect(first.ports.savedFilters[0]).toMatchObject({ name: 'Questions', filterText: 'Beta', filters: { states: ['question'] } })
    first.unmount()

    const second = await mount(SessionsFixtures.mixed(), null, undefined, first.ports.savedFilters)
    expect(buttonNamed(second.container, 'All').getAttribute('aria-pressed')).toBe('false')
    expect(second.container.querySelector('[data-session="s-done"]')).toBeNull()
    fireEvent.click(buttonNamed(second.container, 'Questions'))
    expect(second.container.querySelectorAll('[data-session]')).toHaveLength(1)
    expect(second.container.querySelector('[data-session="s-waiting"]')).toBeTruthy()
    expect(screen.getByRole('textbox', { name: 'Filter sessions' }).getAttribute('value')).toBe('Beta')
    fireEvent.contextMenu(buttonNamed(second.container, 'All'))
    expect(second.container.querySelectorAll('[data-session]')).toHaveLength(SessionsFixtures.mixed().sessions.length)
    fireEvent.contextMenu(buttonNamed(second.container, 'Questions'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete filter' }))
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Saved session filters' })).toBeNull())
    expect(second.ports.savedFilters).toHaveLength(0)
    second.unmount()

    const third = await mount(SessionsFixtures.mixed(), null, undefined, first.ports.savedFilters)
    fireEvent.click(buttonNamed(third.container, 'Filter'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete saved filter' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Questions' }))
    await waitFor(() => expect(third.ports.savedFilters).toHaveLength(0))
    expect(screen.queryByRole('group', { name: 'Saved session filters' })).toBeNull()
  })

  it('keeps the save form and existing chips when storing is refused', async () => {
    const { ports, container } = await mount(SessionsFixtures.mixed())
    ports.filtersAnswer = { ok: true, value: false }
    fireEvent.click(buttonNamed(container, 'Filter'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save filter…' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter name' }), { target: { value: 'Mine' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('could not be stored'))
    expect(screen.getByRole('textbox', { name: 'Filter name' })).toBeTruthy()
    expect(screen.queryByRole('group', { name: 'Saved session filters' })).toBeNull()
    expect(ports.savedFilters).toHaveLength(0)
    ports.filtersAnswer = { ok: true, value: true }
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(buttonNamed(container, 'Mine')).toBeTruthy())
  })

  /** What the panel put in its body, by tag: one tree, or a tree, a heading and a second tree. */
  function bodyPartsOf(container: HTMLElement): string[] {
    return [...partsHostOf(container).children].map((node) => node.tagName.toLowerCase())
  }

  function partOf(container: HTMLElement, index: number): HTMLElement {
    const part = partsHostOf(container).children.item(index)
    if (!(part instanceof HTMLElement))
      throw new Error(`The panel drew no part ${index} in ${bodyOf(container).innerHTML}`)
    return part
  }

  /** Separated puts its three parts in a column inside the body; together has none, and draws one. */
  function partsHostOf(container: HTMLElement): HTMLElement {
    const stack = bodyOf(container).querySelector('.jamat-sessions__stack')
    return stack instanceof HTMLElement ? stack : bodyOf(container)
  }

  function bodyOf(container: HTMLElement): HTMLElement {
    const body = container.querySelector('.jamat-sessions__body')
    if (!(body instanceof HTMLElement))
      throw new Error('The panel drew no body')
    return body
  }

  function sectionAfter(container: HTMLElement, title: string): HTMLElement {
    const heading = [...container.querySelectorAll('.jamat-sessions__section')]
      .find((node) => node.textContent === title)
    const section = heading?.nextElementSibling
    if (!(section instanceof HTMLElement))
      throw new Error(`The sessions tree drew no section after ${JSON.stringify(title)}`)
    return section
  }

  function sectionNames(container: HTMLElement): string[] {
    return [...container.querySelectorAll('.jamat-sessions__section')]
      .map((heading) => heading.textContent ?? '')
  }

  /** A group row by the label it draws: the live count beside it is not part of its name. */
  function groupNamed(root: ParentNode, label: string): HTMLElement {
    const found = [...root.querySelectorAll('.jamat-sessions__group')]
      .find((node) => node.querySelector('.jamat-sessions__label')?.textContent === label)
    if (!(found instanceof HTMLElement))
      throw new Error(`No group row reads ${JSON.stringify(label)} in ${root.textContent}`)
    return found
  }

  /** The same sessions again, with output nobody has been shown on each of the named ones. */
  /**
   * The mark's only source: a turn that CHANGED STATE. Output moving raises nothing any more - an
   * agent TUI repaints its own status row, so a mark measured on arriving bytes was lit on every
   * session nobody was looking at.
   */
  function withActivity(
    snapshot: SessionsSnapshot,
    sessionIds: readonly string[],
    activity: SessionActivity,
  ): SessionsSnapshot {
    return {
      ...snapshot,
      revision: snapshot.revision + 1,
      sessions: snapshot.sessions.map((session) => sessionIds.includes(session.sessionId)
        ? { ...session, activity }
        : session),
    }
  }

  /** The row's OWN character, so one belonging to something drawn under it is not read as this row's. */
  function glyphOf(container: HTMLElement, sessionId: string): Element | null {
    return container.querySelector(
      `[data-session="${sessionId}"] > .jamat-sessions__row .jamat-sessions__glyph`,
    )
  }

  /**
   * There is no dot any more: what a session carries that nobody has seen is said by its state
   * character. For a working or a waiting session the character's COLOUR is spoken for by what that
   * session is doing, so the tooltip is where the unseen half stays readable, and that is what this
   * asks.
   */
  function markedOf(container: HTMLElement, sessionId: string): boolean {
    const title = glyphOf(container, sessionId)?.getAttribute('title')
    return typeof title === 'string' && title.includes('not seen')
  }

  /** The one-shot tint that says this row's state just moved, or null while nothing has. */
  function flashOf(container: HTMLElement, sessionId: string): Element | null {
    return rowOf(container, sessionId).querySelector('.jamat-sessions__flash')
  }

  /** The row's own line, so the tint on a session's install is never read as the session's. */
  function rowOf(container: HTMLElement, sessionId: string): Element {
    const session = [...container.querySelectorAll('.jamat-sessions__session')]
      .find((node) => node.getAttribute('data-session') === sessionId)
    const row = session?.querySelector(':scope > .jamat-sessions__row')
    if (!row)
      throw new Error(`No session row ${sessionId} in ${container.textContent}`)
    return row
  }

  function inFront(container: HTMLElement, sessionId: string): boolean {
    return rowOf(container, sessionId).classList.contains('jamat-sessions__row--in-front')
  }

  /** Whatever the row says about how it ended, as the one element that says it. */
  function exitPillOf(container: HTMLElement, sessionId: string): Element | null {
    return container.querySelector(
      `[data-session="${sessionId}"] > .jamat-sessions__row [class*="pill--exit"]`,
    )
  }

  it('draws a glyph for every state a session can be in', async () => {
    const mixed = SessionsFixtures.mixed()
    const live = sessionOf(mixed, 's-working')
    const everyState: SessionsSnapshot = {
      ...mixed,
      sessions: [
        ...mixed.sessions,
        ...SessionsFixtures.setupOutcomes().sessions,
        // A live agent nothing classifies. It is the one state no recorded fixture holds, and
        // drawing it as idle is exactly how a waiting agent goes unnoticed.
        { ...live, sessionId: 's-unclassified', title: 'Unclassified', activity: 'unknown' },
      ],
    }
    const { container } = await mount(everyState)

    showAll(container)

    const glyphs = [...container.querySelectorAll('[data-glyph]')]
      .map((node) => node.getAttribute('data-glyph'))
    expect([...new Set(glyphs)].sort()).toEqual([
      'ended', 'idle', 'lost', 'shell', 'starting', 'unknown', 'waiting', 'working',
    ])
  })

  /**
   * The colour follows the session, so the row and the tab both carry it. A NAME on an attribute,
   * the same way a glyph is a character: the stylesheet decides what either one looks like.
   */
  it('carries a session colour onto its row, and leaves an uncoloured row bare', async () => {
    const mixed = SessionsFixtures.mixed()
    const { container } = await mount({
      ...mixed,
      sessions: mixed.sessions.map((session) =>
        session.sessionId === 's-working' ? { ...session, color: 'teal' as const } : session),
    })

    const painted = container.querySelector('[data-session="s-working"] > .jamat-sessions__row')
    expect(painted?.getAttribute('data-session-color')).toBe('teal')
    const bare = container.querySelector('[data-session="s-waiting"] > .jamat-sessions__row')
    expect(bare?.hasAttribute('data-session-color')).toBe(false)
  })

  /**
   * Movement is what somebody looking elsewhere catches, so a row whose state moved says so for a
   * moment and then stops. It is about the CHANGE and never about the state, which is why a row
   * this window has only just drawn carries nothing.
   */
  it('tints a row whose state changed, once per change and on that row alone', async () => {
    const snapshot = SessionsFixtures.mixed()
    const { ports, container } = await mount(snapshot)
    expect(flashOf(container, 's-working')).toBeNull()

    const waiting = withActivity(snapshot, ['s-working'], 'waiting')
    ports.push(waiting)

    await waitFor(() => expect(flashOf(container, 's-working')).toBeTruthy())
    const first = flashOf(container, 's-working')
    // Nothing about the row below it moved, so nothing about it blinks.
    expect(flashOf(container, 's-waiting')).toBeNull()

    ports.push(withActivity(waiting, ['s-working'], 'working'))

    // A NEW element, which is the whole point: a tint still fading has to start over rather than
    // carry on where it was.
    await waitFor(() => expect(flashOf(container, 's-working')).not.toBe(first))
    expect(flashOf(container, 's-working')).toBeTruthy()
  })

  // The note is never a label (that is the V2 anti-pattern): the row offers it as its tooltip, and
  // a row without one says just its title there.
  it('offers title and note as the row tooltip, and just the title without a note', async () => {
    const mixed = SessionsFixtures.mixed()
    const { container } = await mount({
      ...mixed,
      sessions: mixed.sessions.map((session) => session.sessionId === 's-working'
        ? { ...session, note: 'Waiting for the review' }
        : session),
    })

    const noted = container.querySelector('[data-session="s-working"] .jamat-sessions__title')
    expect(noted?.getAttribute('title')).toBe('Alpha worktree\n\nWaiting for the review')
    expect(noted?.textContent).toBe('Alpha worktree')
    const bare = container.querySelector('[data-session="s-waiting"] .jamat-sessions__title')
    expect(bare?.getAttribute('title')).toBe('Beta worktree')
  })

  // What the daily view leaves out is what somebody has finished with, not what stopped running.
  it('keeps a finished session out of the tree until the filter asks for it', async () => {
    const { container } = await mount(SessionsFixtures.mixed())
    expect(buttonNamed(container, 'Filter').getAttribute('data-active')).toBe('false')
    fireEvent.click(buttonNamed(container, 'Filter'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Filter by state' }))
    expect(screen.getByRole('menuitemcheckbox', { name: 'Active (unfinished)' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(container.querySelector('[data-session="s-done"]')).toBeNull()
    // A session that ended on its own is unfinished business, so it is in the daily view.
    expect(container.querySelector('[data-session="s-ended"]')).toBeTruthy()

    showAll(container)

    expect(buttonNamed(container, 'Filter').getAttribute('data-active')).toBe('true')
    expect(container.querySelector('[data-session="s-done"]')).toBeTruthy()
    filterBy(container, 'Filter by state', 'Active (unfinished)')
    expect(container.querySelector('[data-session="s-done"]')).toBeNull()
    expect(buttonNamed(container, 'Filter').getAttribute('data-active')).toBe('false')
  })

  it('highlights Filter only while any choice or search text differs from the default', async () => {
    const { container } = await mount(SessionsFixtures.mixed())
    for (const [group, choice] of [
      ['Filter by color', 'Red'], ['Filter by state', 'Question'], ['Filter by type', 'Claude'],
    ]) {
      filterBy(container, group!, choice!)
      expect(buttonNamed(container, 'Filter').getAttribute('data-active')).toBe('true')
      fireEvent.contextMenu(buttonNamed(container, 'Filter'))
      expect(buttonNamed(container, 'Filter').getAttribute('data-active')).toBe('false')
      expect(container.querySelector('[data-session="s-done"]')).toBeNull()
    }
    const text = screen.getByRole('textbox', { name: 'Filter sessions' })
    fireEvent.change(text, { target: { value: 'work' } })
    expect(buttonNamed(container, 'Filter').getAttribute('data-active')).toBe('true')
    fireEvent.contextMenu(buttonNamed(container, 'Filter'))
    expect(text.getAttribute('value')).toBe('')
    expect(buttonNamed(container, 'Filter').getAttribute('data-active')).toBe('false')
  })

  /**
   * The verdict decides, and the number never does. A session somebody finished is killed to end it,
   * so its code is whatever the platform gives a killed process; reading the number here is what put
   * a red exit code beside a `completed` pill on one row, two statements contradicting each other.
   */
  it('names how a session ended, and marks only the bad one as bad', async () => {
    const { container } = await mount(SessionsFixtures.mixed())
    showAll(container)

    // `s-ended` in the fixture failed with 1; `s-adhoc-cased` finished, `s-lost` was interrupted.
    expect(exitPillOf(container, 's-ended')?.textContent).toBe('exit 1')
    expect(exitPillOf(container, 's-ended')?.className)
      .toContain('jamat-sessions__pill--exit')
    expect(exitPillOf(container, 's-adhoc-cased')?.textContent).toBe('finished')
    expect(exitPillOf(container, 's-adhoc-cased')?.className)
      .toContain('jamat-sessions__pill--exit-clean')
    // The code is still there for whoever wants it, out of the way of the answer.
    expect(exitPillOf(container, 's-adhoc-cased')?.getAttribute('title')).toBe('exit 0')
    // The class the stylesheet takes it away by while the row is hovered, where the buttons land.
    for (const sessionId of ['s-ended', 's-adhoc-cased'])
      expect(exitPillOf(container, sessionId)?.className).toContain('jamat-sessions__exit')
    // Lost is not ended: `interrupted` is what that row says, and no code was ever part of it.
    expect(exitPillOf(container, 's-lost')).toBeNull()
    expect(container.querySelector('[data-session="s-lost"]')?.textContent).not.toContain('exit')
  })

  /**
   * A session that ended badly with no code at all is still a failure, and the row says the one true
   * thing it can: that nothing was recorded. The verdict is what put it in that column, not the
   * absent number.
   */
  it('says when a session ended with no code recorded at all', async () => {
    const { container } = await mount(SessionsFixtures.setupOutcomes())
    showAll(container)

    expect(exitPillOf(container, 's-failed')?.textContent).toBe('no exit code')
    // Its install session did record one, so the row underneath keeps saying what it was.
    expect(exitPillOf(container, 's-failed-install')?.textContent).toBe('exit 1')
  })

  it('draws the sessions and then the tabs, as two trees under one heading', async () => {
    const { container } = await mount(SessionsFixtures.mixed())

    // The middle part is the Tabs heading ROW: the heading plus the one action the section owns.
    expect(bodyPartsOf(container)).toEqual(['div', 'div', 'div'])
    expect(partOf(container, 1).querySelector('.jamat-sessions__section')?.textContent)
      .toBe('Tabs')
    expect(partOf(container, 0).querySelector('[data-session="s-working"]')).toBeTruthy()
    expect(partOf(container, 0).querySelector('[data-session="s-tab"]')).toBeNull()
    expect(partOf(container, 2).querySelector('[data-session="s-tab"]')).toBeTruthy()
    expect(partOf(container, 2).querySelector('[data-session="s-working"]')).toBeNull()
  })

  it.each([
    ['neither direction', false, false, ['Tabs']],
    ['outbound only', true, false, ['Tabs', 'Remote']],
    ['inbound only', false, true, ['Tabs', 'Remote connections']],
    ['both directions', true, true, ['Tabs', 'Remote', 'Remote connections']],
  ] as const)(
    'shows remote sections only for connected peers: %s',
    async (_name, outbound, inbound, expected) => {
      const mixed = SessionsFixtures.mixed()
      const { container } = await mount(
        mixed,
        null,
        remoteSnapshot(
          outbound ? [outboundEndpoint(mixed, 'endpoint-a')] : [],
          inbound ? [inboundConnection(['s-working'])] : [],
        ),
      )

      expect(sectionNames(container)).toEqual(expected)
    },
  )

  it('draws connected remote computers after local tabs and omits the only endpoint level', async () => {
    const mixed = SessionsFixtures.mixed()
    const { container, onOpenTerminal } = await mount(
      mixed,
      null,
      remoteSnapshot([outboundEndpoint(mixed, 'endpoint-a')]),
    )
    expect(sectionNames(container)).toEqual(['Tabs', 'Remote'])
    const remote = sectionAfter(container, 'Remote')
    expect(remote.textContent).toContain('Office PC')
    expect(remote.textContent).not.toContain('config-endpoint-a')

    fireEvent.click(buttonNamed(remote, 'Alpha worktree'))
    expect(onOpenTerminal).toHaveBeenCalledWith(
      { kind: 'remote', remoteEndpointId: 'endpoint-a', sessionId: 's-working' },
      sessionOf(mixed, 's-working').tabTitle,
      'preview',
    )
  })

  it('draws endpoint rows only when one computer exposes more than one endpoint', async () => {
    const mixed = SessionsFixtures.mixed()
    const { container } = await mount(
      mixed,
      null,
      remoteSnapshot([
        outboundEndpoint(mixed, 'endpoint-a'),
        outboundEndpoint(mixed, 'endpoint-b'),
      ]),
    )
    const remote = sectionAfter(container, 'Remote')
    expect(remote.textContent).toContain('config-endpoint-a (development)')
    expect(remote.textContent).toContain('config-endpoint-b (development)')
  })

  /**
   * The row of a computer this one is connected to. Both items are about that computer and neither
   * is about a session, which is why it is a menu of its own: starting work over there, and the
   * settings card where everything this row cannot say - offline, still dialling, switched off - is
   * read instead.
   */
  it('offers a connected computer a new session and the settings card', async () => {
    const mixed = SessionsFixtures.mixed()
    const { container, onLaunch, onOpenSettings } = await mount(
      mixed,
      null,
      remoteSnapshot([outboundEndpoint(mixed, 'endpoint-a')]),
    )

    fireEvent.contextMenu(groupRowLabelled(container, 'Office PC'))
    expect(menuTitles()).toEqual(['New session…', 'Disconnect', 'Connect session…', 'Open Remote connections settings'])
    clickMenuItem('New session…')

    // The intent and nothing else: what the launcher makes of it is the launcher's own business.
    expect(onLaunch).toHaveBeenCalledWith({
      purpose: 'remote',
      remote: { remoteEndpointId: 'endpoint-a', displayName: 'Office PC' },
    })

    fireEvent.contextMenu(groupRowLabelled(container, 'Office PC'))
    clickMenuItem('Open Remote connections settings')

    // The screen where an offline or switched-off computer is drawn, which the tree never draws.
    expect(onOpenSettings.mock.calls).toEqual([['remoteControlConnections']])
  })

  /** With two endpoints the computer row names neither, so each endpoint row carries its own. */
  it('names the endpoint the row belongs to when a computer has several', async () => {
    const mixed = SessionsFixtures.mixed()
    const { container, onLaunch } = await mount(
      mixed,
      null,
      remoteSnapshot([
        outboundEndpoint(mixed, 'endpoint-a'),
        outboundEndpoint(mixed, 'endpoint-b'),
      ]),
    )

    fireEvent.contextMenu(groupRowLabelled(container, 'Office PC'))
    expect(document.querySelector('.jamat-tab-menu')).toBeNull()

    fireEvent.contextMenu(groupRowLabelled(container, 'config-endpoint-b (development)'))
    clickMenuItem('New session…')

    expect(onLaunch).toHaveBeenCalledWith({
      purpose: 'remote',
      remote: { remoteEndpointId: 'endpoint-b', displayName: 'Office PC' },
    })
  })

  /** An inbound row is another computer's connection TO this one; nothing here starts work on it. */
  it('opens no computer menu on an inbound connection', async () => {
    const mixed = SessionsFixtures.mixed()
    const { container } = await mount(
      mixed,
      null,
      remoteSnapshot([], [inboundConnection(['s-working'])]),
    )

    fireEvent.contextMenu(groupRowLabelled(container, 'Controller PC'))

    expect(document.querySelector('.jamat-tab-menu')).toBeNull()
  })

  it('keeps selected sessions visible after a connection drops', async () => {
    const mixed = SessionsFixtures.mixed()
    const offline = outboundEndpoint(mixed, 'endpoint-a', {
      status: 'offline',
      connectionId: null,
      error: { code: 'unavailable', detail: 'offline' },
    })
    const { container } = await mount(mixed, null, remoteSnapshot([offline]))

    expect(sectionNames(container)).toEqual(['Tabs', 'Remote'])
  })

  it('disconnects one remote session without running its finish action', async () => {
    const mixed = SessionsFixtures.mixed()
    const { container, remoteCalls, onCloseTerminal } = await mount(mixed, null, remoteSnapshot([outboundEndpoint(mixed, 'endpoint-a')]))
    showAll(container)
    const remote = sectionAfter(container, 'Remote')
    const target = { kind: 'remote' as const, remoteEndpointId: 'endpoint-a', sessionId: 's-working' }
    const row = remote.querySelector(`[data-session='${TerminalTargetCodec.key(target)}']`)
    if (!row) throw new Error('Remote session row missing')
    fireEvent.contextMenu(row.querySelector('.jamat-sessions__row') ?? row)
    clickMenuItem('Disconnect')
    await waitFor(() => expect(remoteCalls).toEqual(['disconnect:endpoint-a:s-working']))
    expect(onCloseTerminal).toHaveBeenCalledWith(target)
  })

  it('routes remote rerun and finish through their endpoint and target key', async () => {
    const mixed = SessionsFixtures.mixed()
    const { container, remoteCalls, onCloseTerminal, onRerunTerminal } = await mount(
      mixed,
      null,
      remoteSnapshot([outboundEndpoint(mixed, 'endpoint-a')]),
    )
    showAll(container)
    const remote = sectionAfter(container, 'Remote')
    const lostKey = TerminalTargetCodec.key({
      kind: 'remote', remoteEndpointId: 'endpoint-a', sessionId: 's-lost',
    })
    chooseSessionMenuAction(remote, lostKey, 'Rerun')
    await waitFor(() => expect(remoteCalls).toContain('reopen:endpoint-a:s-lost'))
    expect(onRerunTerminal).toHaveBeenCalledWith({
      kind: 'remote', remoteEndpointId: 'endpoint-a', sessionId: 's-lost',
    })

    const workingKey = TerminalTargetCodec.key({
      kind: 'remote', remoteEndpointId: 'endpoint-a', sessionId: 's-working',
    })
    fireEvent.click(actionNamed(remote, workingKey, 'Finish'))
    fireEvent.click(actionNamed(remote, workingKey, 'Finish?'))
    await waitFor(() => expect(remoteCalls).toContain('finalize:endpoint-a:s-working'))
    expect(onCloseTerminal).toHaveBeenCalledWith({
      kind: 'remote', remoteEndpointId: 'endpoint-a', sessionId: 's-working',
    })
  })

  // A section that came and went with its contents would make the toggle unreadable: nothing on
  // screen would say whether the arrangement was switched or whether there is simply nothing there.
  it('keeps the Tabs heading when there are no tabs, and says so under it', async () => {
    const { container } = await mount(SessionsFixtures.setupPending())

    expect(bodyPartsOf(container)).toEqual(['div', 'div', 'p'])
    expect(partOf(container, 1).querySelector('.jamat-sessions__section')?.textContent)
      .toBe('Tabs')
    expect(partOf(container, 2).textContent).toBe('No tabs.')
  })

  /*
   * The two trees scroll separately, and that is the whole of this view working: sharing the body's
   * one scroller pushed the heading below the fold once the sessions list was long enough, and the
   * only way to the tabs was scrolling past every session.
   */
  /*
   * One scroller, and the column inside it is what holds the tabs at the foot of the panel: the
   * stylesheet gives that column `min-height: 100%` and the heading `margin-top: auto`, so the free
   * space lands between the two lists and runs out exactly when the sessions fill the panel. jsdom
   * lays nothing out, so what is asserted here is the structure those two rules need.
   */
  it('draws the two trees as one column, so the tabs can sit at its foot', async () => {
    const { container } = await mount(SessionsFixtures.mixed())

    const stack = bodyOf(container).querySelector('.jamat-sessions__stack')
    expect(stack).toBeTruthy()
    expect(bodyOf(container).children).toHaveLength(1)
    expect(partOf(container, 2).querySelector('[data-session="s-tab"]')).toBeTruthy()
  })

  it('draws one tree carrying both kinds once the arrangement is switched, and stores it', async () => {
    const { ports, container } = await mount(SessionsFixtures.mixed())

    fireEvent.click(buttonNamed(container, 'Grouping'))
    expect(screen.getByRole('menuitemcheckbox', { name: 'Tabs separated' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'All together' }))

    expect(bodyPartsOf(container)).toEqual(['div'])
    expect(partOf(container, 0).querySelector('[data-session="s-tab"]')).toBeTruthy()
    expect(partOf(container, 0).querySelector('[data-session="s-working"]')).toBeTruthy()
    expect(buttonNamed(container, 'Grouping').getAttribute('title')).toBe('All together')
    expect(ports.savedViews).toEqual(['together'])
  })

  it('opens in the arrangement the last run was left in', async () => {
    const { ports, container } = await mount(SessionsFixtures.mixed(), 'together')

    await waitFor(() => expect(bodyPartsOf(container))
      .toEqual(['div']))
    expect(buttonNamed(container, 'Grouping').getAttribute('title')).toBe('All together')
    // Restoring is not a change: reading a stored value must not write it straight back.
    expect(ports.savedViews).toEqual([])
  })

  it('groups local and remote sessions by state, keeps filters, and moves a session when its work changes', async () => {
    const source = SessionsFixtures.mixed()
    const remote = { ...source, sessions: [sessionOf(source, 's-waiting')] }
    const { ports, container } = await mount(source, null, remoteSnapshot([outboundEndpoint(remote, 'office')]))
    fireEvent.click(buttonNamed(container, 'Grouping'))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'States separated' }))
    expect(ports.savedViews).toEqual(['states'])
    const groups = [...container.querySelectorAll('.jamat-sessions__stack > section')]
    expect(groups.map((group) => group.getAttribute('aria-label'))).toEqual(['Needs attention', 'Idle unread', 'Running', 'Read'])
    expect(groups[0]!.querySelectorAll('[data-glyph="waiting"]')).toHaveLength(2)
    expect(groups[0]!.textContent).toContain('Office PC')
    expect(groups[1]!.textContent).not.toContain('Office PC')
    expect(groups[2]!.querySelector('[data-session="s-working"]')).toBeTruthy()
    expect(groups[3]!.querySelector('[data-session="s-tab"]')).toBeTruthy()
    expect(container.querySelector('[data-session="s-done"]')).toBeNull()

    ports.push({ ...source, revision: source.revision + 1, sessions: source.sessions.map((session) =>
      session.sessionId === 's-working' ? { ...session, activity: 'idle' } : session) })
    await waitFor(() => expect(groups[2]!.querySelector('[data-session="s-working"]')).toBeNull())
    expect(groups[1]!.querySelector('[data-session="s-working"]')).toBeTruthy()
    filterBy(container, 'Filter by type', 'Codex')
    expect(container.querySelector('[data-session="s-working"]')).toBeNull()
    expect(groups[0]!.querySelectorAll('[data-glyph="waiting"]')).toHaveLength(2)
    fireEvent.click(buttonNamed(container, 'Grouping'))
    fireEvent.contextMenu(buttonNamed(container, 'Grouping'))
    expect(screen.queryByRole('menu', { name: 'Session grouping' })).toBeNull()
    expect(bodyPartsOf(container).slice(0, 3)).toEqual(['div', 'div', 'div'])
    expect(container.querySelector('[data-session="s-working"]')).toBeNull()
    expect(ports.savedViews).toEqual(['states', 'separated'])
  })

  it('restores state grouping without writing it back', async () => {
    const { ports, container } = await mount(SessionsFixtures.mixed(), 'states')
    expect([...container.querySelectorAll('.jamat-sessions__stack > section')]
      .map((group) => group.getAttribute('aria-label'))).toEqual(['Needs attention', 'Idle unread', 'Running', 'Read'])
    expect(buttonNamed(container, 'Grouping').getAttribute('title')).toBe('States separated')
    expect(ports.savedViews).toEqual([])
  })

  it('moves local and remote idle results from unread to read independently', async () => {
    const source = SessionsFixtures.mixed()
    const working = sessionOf(source, 's-working')
    const initial = { ...source, sessions: [working] }
    const { ports, container, pushRemote, setVisibleTargets } = await mount(initial, 'states',
      remoteSnapshot([outboundEndpoint(initial, 'office')]))
    const groups = [...container.querySelectorAll('.jamat-sessions__stack > section')]
    const idle = { ...initial, revision: source.revision + 1, sessions: [{ ...working, activity: 'idle' as const }] }
    ports.push(idle)
    pushRemote(remoteSnapshot([outboundEndpoint(idle, 'office')], [], 2))
    await waitFor(() => expect(groups[1]!.querySelectorAll('[data-glyph="idle"]')).toHaveLength(2))
    expect(groups[2]!.querySelectorAll('[data-session]')).toHaveLength(0)
    expect(groups[3]!.querySelectorAll('[data-session]')).toHaveLength(0)

    setVisibleTargets(['s-working'])
    expect(groups[1]!.querySelectorAll('[data-glyph="idle"]')).toHaveLength(1)
    expect(groups[1]!.textContent).toContain('Office PC')
    expect(groups[3]!.querySelector('[data-session="s-working"]')).toBeTruthy()

    setVisibleTargets([TerminalTargetCodec.key({ kind: 'remote', remoteEndpointId: 'office', sessionId: 's-working' })])
    expect(groups[1]!.querySelectorAll('[data-session]')).toHaveLength(0)
    expect(groups[3]!.querySelectorAll('[data-glyph="idle"]')).toHaveLength(2)
  })

  /**
   * ONE collapsed set for both trees. A project node keeps its id wherever it is drawn, because it is
   * the same project: folding it away is a statement about that project rather than about the section
   * it happens to be in. Two sets would give one twisty two answers inside one panel, and `together`
   * would then need a third.
   */
  it('folds a project away in both trees at once', async () => {
    const { container } = await mount(SessionsFixtures.mixed())
    expect(partOf(container, 2).querySelector('[data-session="s-tab"]')).toBeTruthy()

    fireEvent.click(groupNamed(partOf(container, 0), 'AppJamatV3'))

    expect(container.querySelector('[data-session="s-working"]')).toBeNull()
    expect(container.querySelector('[data-session="s-tab"]')).toBeNull()
    // And nothing else folded with it: this is one project, not the whole tree.
    expect(container.querySelector('[data-session="s-ended"]')).toBeTruthy()
  })

  /** Secondary operations belong to the row menu; the row itself carries only its primary Finish. */
  it('draws only Finish inline and leaves a dead session with no finalize action clean', async () => {
    const { container } = await mount(SessionsFixtures.mixed())

    expect(labelsOf(container, 's-working')).toEqual(['Finish'])
    expect(labelsOf(container, 's-lost')).toEqual([])
    expect(labelsOf(container, 's-ended')).toEqual([])
  })

  it('needs a second click before it finishes a session', async () => {
    const { ports, container } = await mount(SessionsFixtures.mixed())

    fireEvent.click(actionNamed(container, 's-working', 'Finish'))
    expect(ports.calls).toEqual([])

    fireEvent.click(actionNamed(container, 's-working', 'Finish?'))

    expect(ports.calls).toEqual(['finalize:s-working'])
  })

  it('drops an armed live Finish when the committed session stops', async () => {
    const snapshot = SessionsFixtures.mixed()
    const { ports, container } = await mount(snapshot)

    fireEvent.click(actionNamed(container, 's-working', 'Finish'))
    expect(actionNamed(container, 's-working', 'Finish?').textContent).toBe('Finish?')

    const ended = settled(snapshot, 's-working', 'ended', 'finished')
    ports.push(ended)
    await waitFor(() => expect(labelsOf(container, 's-working')[0]).toBe('Finish…'))

    ports.push({ ...snapshot, revision: ended.revision + 1 })
    await waitFor(() => expect(labelsOf(container, 's-working')[0]).toBe('Finish'))
    fireEvent.click(actionNamed(container, 's-working', 'Finish'))

    expect(ports.calls).toEqual([])
    expect(actionNamed(container, 's-working', 'Finish?').textContent).toBe('Finish?')
  })

  it('drops an armed Remove across a full rerun lifecycle', async () => {
    const snapshot = SessionsFixtures.stoppedWorktree()
    const { ports, container } = await mount(snapshot)
    showAll(container)

    chooseSessionMenuAction(container, 's-dirty', 'Remove…')
    expect(actionNamed(container, 's-dirty', 'Remove?').textContent).toBe('Remove?')

    const rerun: SessionsSnapshot = {
      ...snapshot,
      revision: snapshot.revision + 1,
      sessions: snapshot.sessions.map((session) => session.sessionId !== 's-dirty'
        ? session
        : {
            ...session,
            life: 'live',
            outcome: undefined,
            activity: 'working',
            admits: ['finalize', 'restart', 'remove'],
            endedAt: undefined,
            exitCode: undefined,
          }),
    }
    ports.push(rerun)
    await waitFor(() => expect(labelsOf(container, 's-dirty')).toEqual(['Finish']))

    ports.push(settled(rerun, 's-dirty', 'ended', 'finished'))
    await waitFor(() => expect(labelsOf(container, 's-dirty'))
      .toEqual(['Finish…']))

    chooseSessionMenuAction(container, 's-dirty', 'Remove…')
    expect(ports.calls).toEqual([])
    expect(actionNamed(container, 's-dirty', 'Remove?').textContent).toBe('Remove?')
  })

  // The tab was the only place that session was visible, and there is nothing left in it to read.
  it('takes the session terminal with the stop, and only when the stop was accepted', async () => {
    const { ports, onCloseTerminal, container } = await mount(SessionsFixtures.mixed())

    fireEvent.click(actionNamed(container, 's-working', 'Finish'))
    fireEvent.click(actionNamed(container, 's-working', 'Finish?'))

    await waitFor(() => expect(onCloseTerminal)
      .toHaveBeenCalledWith({ kind: 'local', sessionId: 's-working' }))

    ports.answer = { ok: true, value: { ok: false, code: 'op-rejected', detail: 'already gone' } }
    fireEvent.click(actionNamed(container, 's-shell', 'Finish'))
    fireEvent.click(actionNamed(container, 's-shell', 'Finish?'))

    await waitFor(() => expect(container.textContent).toContain('already gone'))
    expect(onCloseTerminal).toHaveBeenCalledTimes(1)
  })

  it('opens the stopped-worktree dialog on the first click without arming the row', async () => {
    const { ports, onCloseTerminal, onFinalizeAsk, container } =
      await mount(SessionsFixtures.stoppedWorktree())
    showAll(container)

    expect(labelsOf(container, 's-dirty'))
      .toEqual(['Finish…'])
    expect(labelsOf(container, 's-clean')[0]).toBe('Finish…')

    fireEvent.click(actionNamed(container, 's-dirty', 'Finish…'))

    expect(actionNamed(container, 's-dirty', 'Finish…').textContent).toBe('Finish…')
    expect(onFinalizeAsk).toHaveBeenCalledTimes(1)
    expect(onFinalizeAsk).toHaveBeenCalledWith(expect.objectContaining({
      target: { kind: 'local', sessionId: 's-dirty' },
      scope: 'local',
      questions: [expect.objectContaining({ specId: 'worktree' })],
    }))
    expect(ports.calls).toEqual([])
    expect(onCloseTerminal).not.toHaveBeenCalled()
  })

  it('restores stopped Finish after an armed Remove is cancelled', async () => {
    const { ports, onFinalizeAsk, container } = await mount(SessionsFixtures.stoppedWorktree())
    showAll(container)

    chooseSessionMenuAction(container, 's-dirty', 'Remove…')
    expect(actionNamed(container, 's-dirty', 'Remove?').textContent).toBe('Remove?')

    fireEvent.click(rowOf(container, 's-dirty'))
    expect(labelsOf(container, 's-dirty')).toEqual(['Finish…'])
    fireEvent.click(actionNamed(container, 's-dirty', 'Finish…'))

    expect(onFinalizeAsk).toHaveBeenCalledOnce()
    expect(labelsOf(container, 's-dirty')).toEqual(['Finish…'])
    expect(ports.calls).toEqual([])
  })

  it('offers failed-install discard through Finish only on the local tree', async () => {
    const snapshot = SessionsFixtures.setupOutcomes()
    const { container, onFinalizeAsk } = await mount(
      snapshot,
      null,
      remoteSnapshot([outboundEndpoint(snapshot, 'endpoint-a')]),
    )
    showAll(container)

    expect(labelsOf(container, 's-failed')).toEqual(['Finish…'])
    fireEvent.click(actionNamed(container, 's-failed', 'Finish…'))
    expect(onFinalizeAsk).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'local',
      questions: [expect.objectContaining({
        specId: 'worktree',
        question: expect.objectContaining({
          choices: expect.arrayContaining([
            expect.objectContaining({ id: 'keep' }),
            expect.objectContaining({ id: 'discard' }),
          ]),
          chosenDefault: 'keep',
        }),
      })],
    }))

    const remote = sectionAfter(container, 'Remote')
    const remoteKey = TerminalTargetCodec.key({
      kind: 'remote', remoteEndpointId: 'endpoint-a', sessionId: 's-failed',
    })
    expect(labelsOf(remote, remoteKey)).toEqual([])
  })

  it('opens a remote merge dialog without a discard choice or remote operation', async () => {
    const snapshot = SessionsFixtures.stoppedWorktree()
    const { container, onFinalizeAsk, remoteCalls } = await mount(
      snapshot,
      null,
      remoteSnapshot([outboundEndpoint(snapshot, 'endpoint-a')]),
    )
    showAll(container)
    const remote = sectionAfter(container, 'Remote')
    const remoteKey = TerminalTargetCodec.key({
      kind: 'remote', remoteEndpointId: 'endpoint-a', sessionId: 's-dirty',
    })

    expect(labelsOf(remote, remoteKey)).toEqual(['Finish…'])
    fireEvent.click(actionNamed(remote, remoteKey, 'Finish…'))

    expect(onFinalizeAsk).toHaveBeenCalledTimes(1)
    const ask = onFinalizeAsk.mock.calls[0]?.[0]
    expect(ask).toMatchObject({
      target: { kind: 'remote', remoteEndpointId: 'endpoint-a', sessionId: 's-dirty' },
      scope: 'remote',
    })
    expect(ask.questions[0].question.choices.map((choice: { id: string }) => choice.id))
      .toEqual(['merge', 'keep'])
    expect(remoteCalls).toEqual([])
  })

  it('routes Finish from an open remote menu through the current ended snapshot', async () => {
    const snapshot = SessionsFixtures.mixed()
    const { container, onFinalizeAsk, remoteCalls, pushRemote } = await mount(
      snapshot,
      null,
      remoteSnapshot([outboundEndpoint(snapshot, 'endpoint-a')]),
    )
    showAll(container)
    const remote = sectionAfter(container, 'Remote')
    const targetKey = TerminalTargetCodec.key({
      kind: 'remote', remoteEndpointId: 'endpoint-a', sessionId: 's-working',
    })
    fireEvent.contextMenu(rowOf(remote, targetKey))

    const ended = settled(snapshot, 's-working', 'ended', 'finished')
    pushRemote(remoteSnapshot([outboundEndpoint(ended, 'endpoint-a')], [], 2))
    await waitFor(() => expect(labelsOf(remote, targetKey)[0]).toBe('Finish…'))
    clickMenuItem('Finish')

    expect(onFinalizeAsk).toHaveBeenCalledOnce()
    expect(onFinalizeAsk).toHaveBeenCalledWith(expect.objectContaining({
      target: { kind: 'remote', remoteEndpointId: 'endpoint-a', sessionId: 's-working' },
      scope: 'remote',
    }))
    expect(remoteCalls).toEqual([])
  })

  describe('stop then ask', () => {
    it.each([
      ['ended', 'ended', 'finished'],
      ['failed', 'ended', 'failed'],
      ['lost', 'lost', 'interrupted'],
    ] as const)('opens one ask when an accepted stop becomes %s', async (_label, life, outcome) => {
      const snapshot = SessionsFixtures.mixed()
      const { ports, container, onCloseTerminal, onFinalizeAsk } = await mount(snapshot)

      confirmFinish(container, 's-working')
      await waitFor(() => expect(ports.calls).toEqual(['finalize:s-working']))
      await waitFor(() => expect(onCloseTerminal).toHaveBeenCalledWith({
        kind: 'local', sessionId: 's-working',
      }))
      expect(onFinalizeAsk).not.toHaveBeenCalled()

      ports.push(settled(snapshot, 's-working', life, outcome))

      await waitFor(() => expect(onFinalizeAsk).toHaveBeenCalledTimes(1))
      expect(onFinalizeAsk).toHaveBeenCalledWith(expect.objectContaining({
        target: { kind: 'local', sessionId: 's-working' },
        scope: 'local',
      }))
    })

    it('registers no wait when stop was refused', async () => {
      const snapshot = SessionsFixtures.mixed()
      const { ports, container, onFinalizeAsk } = await mount(snapshot)
      ports.answer = {
        ok: true,
        value: { ok: false, code: 'live-refused', detail: 'the session is still running' },
      }

      confirmFinish(container, 's-working')
      await waitFor(() => expect(container.textContent).toContain('the session is still running'))
      ports.push({
        ...settled(snapshot, 's-working', 'ended', 'finished'),
        revision: snapshot.revision + 2,
      })
      await waitFor(() => expect(glyphOf(container, 's-working')?.getAttribute('data-glyph'))
        .toBe('ended'))

      expect(onFinalizeAsk).not.toHaveBeenCalled()
    })

    it('disables Finish while waiting and starts no second wait', async () => {
      const snapshot = SessionsFixtures.mixed()
      const { ports, container, onFinalizeAsk } = await mount(snapshot)

      confirmFinish(container, 's-working')
      const finish = actionNamed(container, 's-working', 'Finish') as HTMLButtonElement
      await waitFor(() => expect(finish.disabled).toBe(true))
      fireEvent.click(finish)

      expect(ports.calls).toEqual(['finalize:s-working'])
      ports.push(settled(snapshot, 's-working', 'ended', 'finished'))
      await waitFor(() => expect(onFinalizeAsk).toHaveBeenCalledTimes(1))
    })

    it('blocks a remote menu duplicate without reopening its terminal while waiting', async () => {
      const snapshot = SessionsFixtures.mixed()
      const { container, remoteCalls, onOpenTerminal } = await mount(
        snapshot,
        null,
        remoteSnapshot([outboundEndpoint(snapshot, 'endpoint-a')]),
      )
      showAll(container)
      const remote = sectionAfter(container, 'Remote')
      const targetKey = TerminalTargetCodec.key({
        kind: 'remote', remoteEndpointId: 'endpoint-a', sessionId: 's-working',
      })

      confirmFinish(remote, targetKey)
      await waitFor(() => expect(remoteCalls).toEqual(['finalize:endpoint-a:s-working']))
      await waitFor(() => expect((actionNamed(
        remote,
        targetKey,
        'Finish',
      ) as HTMLButtonElement).disabled).toBe(true))
      const openCalls = onOpenTerminal.mock.calls.length

      fireEvent.contextMenu(rowOf(remote, targetKey))
      clickMenuItem('Finish')

      expect(remoteCalls).toEqual(['finalize:endpoint-a:s-working'])
      expect(onOpenTerminal).toHaveBeenCalledTimes(openCalls)
    })

    it('keeps a newly accepted wait while another wait settles in the same batch', async () => {
      const snapshot = SessionsFixtures.mixed()
      const { ports, container, onFinalizeAsk } = await mount(snapshot)

      confirmFinish(container, 's-working')
      await waitFor(() => expect((actionNamed(
        container,
        's-working',
        'Finish',
      ) as HTMLButtonElement).disabled).toBe(true))

      ports.hold()
      confirmFinish(container, 's-waiting')
      await waitFor(() => expect(ports.calls).toEqual([
        'finalize:s-working',
        'finalize:s-waiting',
      ]))
      const firstSettled = settled(snapshot, 's-working', 'ended', 'finished')
      await act(async () => {
        ports.push(firstSettled)
        await Promise.resolve()
        ports.release()
        await Promise.resolve()
      })

      await waitFor(() => expect(onFinalizeAsk).toHaveBeenCalledTimes(1))
      await waitFor(() => expect((actionNamed(
        container,
        's-waiting',
        'Finish',
      ) as HTMLButtonElement).disabled).toBe(true))

      ports.push(settled(firstSettled, 's-waiting', 'ended', 'finished'))

      await waitFor(() => expect(onFinalizeAsk).toHaveBeenCalledTimes(2))
      expect(onFinalizeAsk.mock.calls.map(([ask]) => ask.target)).toEqual([
        { kind: 'local', sessionId: 's-working' },
        { kind: 'local', sessionId: 's-waiting' },
      ])
    })

    it('drops a wait when the local session disappears', async () => {
      const snapshot = SessionsFixtures.mixed()
      const { ports, container, onFinalizeAsk } = await mount(snapshot)
      confirmFinish(container, 's-working')
      await waitFor(() => expect((actionNamed(
        container,
        's-working',
        'Finish',
      ) as HTMLButtonElement).disabled).toBe(true))

      ports.push({
        ...snapshot,
        revision: snapshot.revision + 1,
        sessions: snapshot.sessions.filter((session) => session.sessionId !== 's-working'),
      })
      await waitFor(() => expect(container.querySelector('[data-session="s-working"]')).toBeNull())
      ports.push({
        ...settled(snapshot, 's-working', 'ended', 'finished'),
        revision: snapshot.revision + 2,
      })
      await waitFor(() => expect(labelsOf(container, 's-working')[0]).toBe('Finish…'))

      expect(onFinalizeAsk).not.toHaveBeenCalled()
    })

    it('clears a settled wait whose fresh catalog has no question', async () => {
      const snapshot = SessionsFixtures.mixed()
      const { ports, container, onFinalizeAsk } = await mount(snapshot)
      confirmFinish(container, 's-shell')
      await waitFor(() => expect((actionNamed(
        container,
        's-shell',
        'Finish',
      ) as HTMLButtonElement).disabled).toBe(true))

      const ended = settled(snapshot, 's-shell', 'ended', 'finished')
      ports.push(ended)
      await waitFor(() => expect(labelsOf(container, 's-shell')).toEqual([]))
      const worktree = sessionOf(snapshot, 's-working').worktree
      if (worktree === undefined) throw new Error('The fixture has no worktree to add')
      ports.push({
        ...ended,
        revision: ended.revision + 1,
        sessions: ended.sessions.map((session) => session.sessionId !== 's-shell'
          ? session
          : { ...session, worktree, admits: [...session.admits, 'discardWorktree'] }),
      })
      await waitFor(() => expect(labelsOf(container, 's-shell')[0]).toBe('Finish…'))

      expect(onFinalizeAsk).not.toHaveBeenCalled()
    })

    it('keeps a remote wait through a null payload and opens a remote ask when it settles', async () => {
      const snapshot = SessionsFixtures.mixed()
      const initialRemote = remoteSnapshot([outboundEndpoint(snapshot, 'endpoint-a')])
      const { container, remoteCalls, onCloseTerminal, onFinalizeAsk, pushRemote } =
        await mount(snapshot, null, initialRemote)
      showAll(container)
      const remote = sectionAfter(container, 'Remote')
      const target = {
        kind: 'remote' as const,
        remoteEndpointId: 'endpoint-a',
        sessionId: 's-working',
      }
      const targetKey = TerminalTargetCodec.key(target)

      confirmFinish(remote, targetKey)
      await waitFor(() => expect(remoteCalls).toEqual(['finalize:endpoint-a:s-working']))
      await waitFor(() => expect(onCloseTerminal).toHaveBeenCalledWith(target))
      await waitFor(() => expect((actionNamed(
        remote,
        targetKey,
        'Finish',
      ) as HTMLButtonElement).disabled).toBe(true))
      pushRemote(remoteSnapshot(
        [outboundEndpoint(snapshot, 'endpoint-a', { sessions: null })],
        [],
        2,
      ))
      expect(onFinalizeAsk).not.toHaveBeenCalled()

      const ended = settled(snapshot, 's-working', 'ended', 'finished')
      pushRemote(remoteSnapshot([outboundEndpoint(ended, 'endpoint-a')], [], 3))

      await waitFor(() => expect(onFinalizeAsk).toHaveBeenCalledTimes(1))
      const ask = onFinalizeAsk.mock.calls[0]?.[0]
      expect(ask).toMatchObject({ target, scope: 'remote' })
      expect(ask.questions[0].question.choices.map((choice: { id: string }) => choice.id))
        .toEqual(['merge', 'keep'])
    })

    it('drops a remote wait when its endpoint disconnects', async () => {
      const snapshot = SessionsFixtures.mixed()
      const { container, onFinalizeAsk, pushRemote } = await mount(
        snapshot,
        null,
        remoteSnapshot([outboundEndpoint(snapshot, 'endpoint-a')]),
      )
      showAll(container)
      const remote = sectionAfter(container, 'Remote')
      const targetKey = TerminalTargetCodec.key({
        kind: 'remote', remoteEndpointId: 'endpoint-a', sessionId: 's-working',
      })
      confirmFinish(remote, targetKey)
      await waitFor(() => expect((actionNamed(
        remote,
        targetKey,
        'Finish',
      ) as HTMLButtonElement).disabled).toBe(true))

      pushRemote(remoteSnapshot([outboundEndpoint(snapshot, 'endpoint-a', {
        status: 'offline',
        connectionId: null,
      })], [], 2))
      await waitFor(() => expect(container.querySelector('.jamat-sessions__remote-status--offline')).not.toBeNull())
      const ended = settled(snapshot, 's-working', 'ended', 'finished')
      pushRemote(remoteSnapshot([outboundEndpoint(ended, 'endpoint-a')], [], 3))
      await waitFor(() => expect(sectionNames(container)).toEqual(['Tabs', 'Remote']))

      expect(onFinalizeAsk).not.toHaveBeenCalled()
    })

    it('owns no wait after the tree unmounts', async () => {
      const snapshot = SessionsFixtures.mixed()
      const { ports, container, onCloseTerminal, onFinalizeAsk, unmount } = await mount(snapshot)
      confirmFinish(container, 's-working')
      await waitFor(() => expect(ports.calls).toEqual(['finalize:s-working']))
      await waitFor(() => expect(onCloseTerminal).toHaveBeenCalledWith({
        kind: 'local', sessionId: 's-working',
      }))

      unmount()
      ports.push(settled(snapshot, 's-working', 'ended', 'finished'))
      await Promise.resolve()

      expect(onFinalizeAsk).not.toHaveBeenCalled()
    })
  })

  /** A stopped session is not a crashed one, whatever code the kill left behind. */
  it('draws no failure on a session somebody finished', async () => {
    const { container } = await mount(SessionsFixtures.stoppedWorktree())
    showAll(container)

    expect(exitPillOf(container, 's-dirty')?.textContent).toBe('finished')
    // The class list, not a substring of it: `--exit-clean` contains `--exit`, so a substring check
    // here passes for the red pill as readily as for the quiet one.
    expect(exitPillOf(container, 's-dirty')?.className.split(' '))
      .toContain('jamat-sessions__pill--exit-clean')
    expect(exitPillOf(container, 's-dirty')?.className.split(' '))
      .not.toContain('jamat-sessions__pill--exit')
    expect(exitPillOf(container, 's-dirty')?.getAttribute('title')).toBe('exit -1073741510')
  })

  /**
   * The question is asked ABOUT a session, so it is asked over that session: the first of the two
   * clicks puts the terminal on screen, before the confirmation rather than after it.
   */
  it('opens the row terminal on the first click of an action that confirms', async () => {
    const { ports, onOpenTerminal, container } = await mount(SessionsFixtures.mixed())
    showAll(container)

    chooseSessionMenuAction(container, 's-ended', 'Remove…')

    expect(onOpenTerminal.mock.calls).toEqual([[
      { kind: 'local', sessionId: 's-ended' },
      'WebJamatAdmin - Ended codex',
      'preview',
    ]])
    expect(ports.calls).toEqual([])
    expect(actionNamed(container, 's-ended', 'Remove?').textContent).toBe('Remove?')
  })

  // Every action, not only the confirmed ones: one that acts at once loses nothing by first showing
  // the session it is acting on.
  it('opens it for an action that acts on the first click too', async () => {
    const { onOpenTerminal, container } = await mount(SessionsFixtures.setupOutcomes())
    showAll(container)

    chooseSessionMenuAction(container, 's-failed', 'Retry setup')

    expect(onOpenTerminal.mock.calls).toEqual([[
      { kind: 'local', sessionId: 's-failed' },
      'AppJamatV3 - Beta worktree',
      'preview',
    ]])
  })

  /**
   * The consumer `SessionsTreeModel.withIdentity` was written for, and did not have until
   * 2026-08-21: it keeps the previous node object for every row a tick did not move, which changes
   * nothing unless something compares that identity. Every row was a plain function, and `chrome`
   * was a fresh literal on every render, so the whole tree re-rendered on every poll while the
   * fingerprint pass serialized every node for nothing.
   *
   * Counted through `characterOf`, which each session row calls once as it draws its glyph.
   */
  it('re-renders only the rows a tick moved', async () => {
    const mixed = SessionsFixtures.mixed()
    const { ports, container } = await mount(mixed)
    showAll(container)
    const working = withActivity(mixed, ['s-working', 's-waiting'], 'working')
    ports.push(working)
    await waitFor(() =>
      expect(glyphOf(container, 's-waiting')?.getAttribute('data-glyph')).toBe('working'))

    const drawn = vi.spyOn(SessionNodeState, 'characterOf')
    ports.push(withActivity(working, ['s-waiting'], 'idle'))
    await waitFor(() =>
      expect(glyphOf(container, 's-waiting')?.getAttribute('data-glyph')).toBe('idle'))

    // One session moved. Without the memo every drawn row was redrawn, and this fixture has far
    // more than two of them.
    expect(drawn.mock.calls.length).toBeLessThanOrEqual(2)
    drawn.mockRestore()
  })

  /**
   * The merge word is the only thing on the row that says Finish did not get home, and until
   * 2026-08-21 no fixture carried a `merge` field at all: `SessionsTreeGlyphs.mergeTextOf` had one
   * call site and no test ever reached it. Deleting the whole block left the suite green.
   */
  it('draws what a merge is doing on the row, and nests the resolver under it', async () => {
    const { container } = await mount(SessionsFixtures.merging())
    showAll(container)

    const wordOf = (sessionId: string): HTMLElement => {
      const row = container.querySelector(
        `[data-session="${sessionId}"] > .jamat-sessions__row .jamat-sessions__merge`,
      )
      if (!(row instanceof HTMLElement))
        throw new Error(`No merge word on ${sessionId} in ${container.textContent}`)
      return row
    }

    expect(wordOf('s-merging').textContent).toBe('merging…')
    expect(wordOf('s-merging').dataset.merge).toBe('merging')
    expect(wordOf('s-merging').title).toBe('Merging the worktree back to its base')

    expect(wordOf('s-conflicted').textContent).toBe('conflict')
    expect(wordOf('s-conflicted').dataset.merge).toBe('conflict')

    // A failure outranks the phase: both of these are `resolving`, and only one says so.
    expect(wordOf('s-merge-failed').textContent).toBe('merge failed')
    expect(wordOf('s-merge-failed').dataset.merge).toBe('merge-failed')
    expect(wordOf('s-merge-failed').title)
      .toBe('the resolver finished and the conflict is still there')

    // And the resolver is a child of the session it is resolving for, not a row beside it.
    expect(container.querySelector('[data-session="s-conflicted"] [data-session="s-resolver"]'))
      .not.toBeNull()
  })

  /**
   * Rerun, Retry setup and Adopt act on the FIRST click, so a second one used to fire a second call.
   * The library runs one operation at a time: the second reaches a record the first has already
   * moved and answers `launch-pending`, in red, under the filter, for an action that worked.
   */
  it('fires one call per action while its own answer is still out', async () => {
    const { ports, container } = await mount(SessionsFixtures.setupOutcomes())
    showAll(container)
    ports.hold()

    chooseSessionMenuAction(container, 's-failed', 'Retry setup')
    await waitFor(() => expect(ports.calls).toEqual(['retrySetup:s-failed']))
    chooseSessionMenuAction(container, 's-failed', 'Retry setup')

    expect(ports.calls).toEqual(['retrySetup:s-failed'])

    ports.release()
  })

  /**
   * One line per operation, not one line for the panel. The failure of one used to be wiped by the
   * NEXT operation answering ok - including an operation on another session - so a reason could be
   * gone before anybody read it.
   */
  it('keeps one operation failure while another one succeeds', async () => {
    const { ports, container } = await mount(SessionsFixtures.mixed())
    showAll(container)
    ports.answers.set('remove:s-lost', {
      ok: true,
      value: { ok: false, code: 'launch-pending', detail: 'a launch is already waiting' },
    })

    chooseSessionMenuAction(container, 's-lost', 'Remove…')
    fireEvent.click(actionNamed(container, 's-lost', 'Remove?'))
    await waitFor(() =>
      expect(container.querySelector('.jamat-sessions__error')?.textContent)
        .toContain('a launch is already waiting'))

    chooseSessionMenuAction(container, 's-ended', 'Remove…')
    fireEvent.click(actionNamed(container, 's-ended', 'Remove?'))
    await waitFor(() => expect(ports.calls).toContain('remove:s-ended'))

    expect(container.querySelector('.jamat-sessions__error')?.textContent)
      .toContain('a launch is already waiting')
  })

  /**
   * A mark says "this happened while you were elsewhere", so the row being looked at is the one row
   * that must never carry one. Only a new snapshot used to answer this, and the id of the session on
   * screen was not even asked for - so an open and read session kept its dot until something else
   * produced output.
   */
  it('takes the mark off the session being looked at and leaves the others theirs', async () => {
    const mixed = SessionsFixtures.mixed()
    const { ports, container, setVisibleTargets } = await mount(mixed)
    // The first snapshot is a baseline and raises nothing; a mark needs a turn to settle, so both
    // sessions are put to work first and then allowed to finish.
    const working = withActivity(mixed, ['s-working', 's-waiting'], 'working')
    ports.push(working)
    // Awaited rather than pushed back to back: two snapshots in one tick reach the model as one,
    // and a settle is a transition BETWEEN two of them.
    await waitFor(() =>
      expect(glyphOf(container, 's-waiting')?.getAttribute('data-glyph')).toBe('working'))
    ports.push(withActivity(working, ['s-working', 's-waiting'], 'idle'))
    await waitFor(() => expect(markedOf(container, 's-working')).toBe(true))
    expect(markedOf(container, 's-waiting')).toBe(true)

    setVisibleTargets(['s-working'])

    expect(markedOf(container, 's-working')).toBe(false)
    expect(markedOf(container, 's-waiting')).toBe(true)

    // And a switch to the other tab puts that one out without lighting the one just left.
    setVisibleTargets(['s-waiting'])

    expect(markedOf(container, 's-waiting')).toBe(false)
    expect(markedOf(container, 's-working')).toBe(false)
  })

  /**
   * The tint says where this window is. The marks answer the separate cross-window question of
   * whether a session is visible anywhere, so their last payload may name another target.
   */
  it('tints the row of the session whose tab is in front', async () => {
    const { container, lookAt, setVisibleTargets } = await mount(SessionsFixtures.mixed())
    expect(inFront(container, 's-working')).toBe(false)

    // This is the cross-window answer that used to drive the tint. Leave it stale on purpose:
    // switching tabs in this window must move the current row without waiting for that round trip.
    setVisibleTargets(['s-working'])
    lookAt('s-working')

    expect(inFront(container, 's-working')).toBe(true)
    expect(rowOf(container, 's-working').getAttribute('aria-current')).toBe('true')
    expect(inFront(container, 's-waiting')).toBe(false)

    // One row at a time: the one left goes back to being listed, not to being a second current row.
    lookAt('s-waiting')

    expect(inFront(container, 's-working')).toBe(false)
    expect(inFront(container, 's-waiting')).toBe(true)

    // And a window with no terminal in front leaves the panel with nothing tinted at all.
    lookAt(null)

    expect(inFront(container, 's-waiting')).toBe(false)
    expect(rowOf(container, 's-waiting').getAttribute('aria-current')).toBeNull()
  })

  it('tints a remote row without tinting the local session with the same id', async () => {
    const mixed = SessionsFixtures.mixed()
    const target = {
      kind: 'remote' as const,
      remoteEndpointId: 'endpoint-a',
      sessionId: 's-working',
    }
    const { container, lookAtTarget } = await mount(
      mixed,
      null,
      remoteSnapshot([outboundEndpoint(mixed, target.remoteEndpointId)]),
    )

    lookAtTarget(target)

    expect(inFront(container, 's-working')).toBe(false)
    expect(inFront(container, TerminalTargetCodec.key(target))).toBe(true)
  })

  it('needs a second click before it removes a record', async () => {
    const { ports, container } = await mount(SessionsFixtures.mixed())
    showAll(container)

    chooseSessionMenuAction(container, 's-ended', 'Remove…')
    expect(ports.calls).toEqual([])
    const row = rowOf(container, 's-ended')
    expect(row).toHaveClass('jamat-sessions__row--confirming')

    fireEvent.click(actionNamed(container, 's-ended', 'Remove?'))

    expect(ports.calls).toEqual(['remove:s-ended'])
  })

  // An armed question that survived a click elsewhere would be answered by whatever the user does
  // next, which is the accident the second click exists to prevent.
  it('takes the question back when the next click lands somewhere else', async () => {
    const { ports, container } = await mount(SessionsFixtures.mixed())
    fireEvent.click(actionNamed(container, 's-working', 'Finish'))

    const elsewhere = container.querySelector('[data-session="s-shell"] .jamat-sessions__title')
    if (!(elsewhere instanceof HTMLElement))
      throw new Error('The tree drew no second session to click on')
    fireEvent.click(elsewhere)

    expect(actionNamed(container, 's-working', 'Finish').textContent).toBe('Finish')
    expect(ports.calls).toEqual([])
  })

  /*
   * Bringing a stopped session back is `Resume session` since 2026-09-10, and it is a CATALOG
   * command: this row names the session and stops there, and the card that command opens is what
   * calls the library and tells the tab to attach again. The row's own operations - Finish, Remove,
   * Retry setup - still act from here, which is why the tests above use one of those.
   */
  it('hands a stopped row to the resume command and calls the library for none of it', async () => {
    const { ports, commands, container, onRerunTerminal } = await mount(SessionsFixtures.mixed())
    const execute = vi.spyOn(commands, 'execute').mockReturnValue('handled')

    showAll(container)
    chooseSessionMenuAction(container, 's-lost', 'Resume session')

    expect(execute.mock.calls).toEqual([['session.resume', { sessionId: 's-lost' }]])
    expect(ports.calls).toEqual([])
    expect(onRerunTerminal.mock.calls).toEqual([])
  })

  it('says what the library refused, in the words it refused with', async () => {
    const { ports, container } = await mount(SessionsFixtures.mixed())
    ports.answer = { ok: true, value: { ok: false, code: 'live-refused', detail: 'it is running' } }
    showAll(container)

    chooseSessionMenuAction(container, 's-ended', 'Remove…')
    fireEvent.click(actionNamed(container, 's-ended', 'Remove?'))

    await waitFor(() => expect(container.querySelector('.jamat-sessions__error')?.textContent)
      .toBe('Remove failed: live-refused: it is running'))
  })

  it('counts the orphans and adopts the one it lists', async () => {
    const { ports, container } = await mount(SessionsFixtures.mixed())

    fireEvent.click(buttonNamed(container, 'Orphans (1)'))
    expect(container.textContent).toContain('orphan-1')
    fireEvent.click(buttonNamed(container, 'Adopt'))

    expect(ports.calls).toEqual(['adoptOrphan:orphan-1'])
  })

  /**
   * What the Host is doing is the status bar's line, and the panel drew a second copy of it that had
   * to be kept in step with the first. What the panel still owes the reader is its own rows.
   */
  it('keeps the sessions it knows while nobody can reach the Host, and says nothing about it', async () => {
    const { container } = await mount(SessionsFixtures.hostUnreachable())

    // Unreachable is the HOST's state: a session drawn as lost here would be a session this client
    // decided about while it could not ask anybody.
    expect(container.querySelector('[data-session="s-working"] [data-glyph]')
      ?.getAttribute('data-glyph')).toBe('working')
    expect(container.textContent).not.toContain('Host')
  })

  it('writes the project into the intent when the launch comes from a project row', async () => {
    const { onLaunch, container } = await mount(SessionsFixtures.mixed())
    showAll(container)

    fireEvent.click(labelled(container, '+ Session in AppJamatV3'))

    const binding = {
      mode: 'project',
      categoryId: 'nodejs',
      projectName: 'AppJamatV3',
      projectPath: 'C:/Projects/NodeJs/AppJamatV3',
    }
    expect(onLaunch.mock.calls).toEqual([[{ prefill: { binding } }]])
  })

  it('names only the category when the launch comes from a category row', async () => {
    const { onLaunch, container } = await mount(SessionsFixtures.mixed())
    showAll(container)

    fireEvent.click(labelled(container, '+ Session in NodeJs'))

    expect(onLaunch.mock.calls).toEqual([[{ category: 'nodejs' }]])
  })

  /*
   * The section's own action: a tab belongs to no project row, so it names no place and the card
   * asks which one. It is the pointer's half of the same thing the keyboard does.
   */
  it('opens the tab card from the Tabs heading, naming no project', async () => {
    const { onLaunch, container } = await mount(SessionsFixtures.mixed())

    fireEvent.click(labelled(container, 'New tab'))

    expect(onLaunch.mock.calls).toEqual([[{ purpose: 'tabProfile' }]])
  })

  /*
   * Drawn the way every other action in this panel is drawn, which is the whole point of there being
   * one button component: the same class, and inside the container that only appears under the
   * pointer. It arrived outside that container once, and was then the single button in the panel
   * that was always on screen.
   */
  it('draws the Tabs action like every other row action', async () => {
    const { container } = await mount(SessionsFixtures.mixed())
    showAll(container)
    const tabAction = labelled(container, 'New tab')
    const sessionAction = labelled(container, '+ Session in AppJamatV3')

    expect(tabAction.className).toBe(sessionAction.className)
    expect(tabAction.closest('.jamat-sessions__group-actions')).toBeTruthy()
    expect(sessionAction.closest('.jamat-sessions__group-actions')).toBeTruthy()
  })

  /**
   * The row is how a session that is already running is looked at, and a tab is the only place it
   * can be seen at all. The row reads `Alpha worktree` because it hangs under its project already;
   * the tab it opens carries the project too, because a tab hangs under nothing.
   */
  it('opens the terminal of the session whose title was clicked', async () => {
    const { onOpenTerminal, container } = await mount(SessionsFixtures.mixed())
    showAll(container)

    const title = container.querySelector('[data-session="s-working"] .jamat-sessions__title')
    if (!title) throw new Error('the working session has no title')
    expect(title.textContent).toBe('Alpha worktree')
    fireEvent.click(title)

    expect(onOpenTerminal.mock.calls).toEqual([[
      { kind: 'local', sessionId: 's-working' },
      'AppJamatV3 - Alpha worktree',
      'preview',
    ]])
  })

  /**
   * The gesture that says "keep this one". The browser sends both clicks of a double-click first,
   * so the tab is opened provisionally twice and then asked for permanently; each step is right on
   * its own, which is why no debounce sits between them.
   */
  it('opens the terminal permanently when the title is double-clicked', async () => {
    const { onOpenTerminal, container } = await mount(SessionsFixtures.mixed())
    showAll(container)

    const title = container.querySelector('[data-session="s-working"] .jamat-sessions__title')
    if (!title) throw new Error('the working session has no title')
    fireEvent.doubleClick(title)

    expect(onOpenTerminal.mock.calls.at(-1))
      .toEqual([
        { kind: 'local', sessionId: 's-working' },
        'AppJamatV3 - Alpha worktree',
        'permanent',
      ])
  })

  /**
   * The tree is a surface for the mouse. Whatever was clicked - a row, a twisty, a chip, the padding
   * between them - the keyboard goes back to the terminal in front, so a person who came here to
   * look at a session can type into it without clicking a second time.
   */
  it('hands the keyboard back to the terminal on a click anywhere in it', async () => {
    const { onFocusTerminal, container } = await mount(SessionsFixtures.mixed())
    // The filter chip `showAll` presses is a click in here too, and hands the keyboard over exactly
    // like the row below does. Counted from after it, so this asserts about the row alone.
    showAll(container)
    onFocusTerminal.mockClear()

    const title = container.querySelector('[data-session="s-working"] .jamat-sessions__title')
    if (!title) throw new Error('the working session has no title')
    fireEvent.click(title)

    expect(onFocusTerminal).toHaveBeenCalledOnce()
  })

  /**
   * The row menu is a portal, so React bubbles its clicks through the tree while the DOM does not.
   * An item that opens another panel would otherwise leave the caret in a terminal nobody is
   * looking at.
   */
  it('leaves the caret alone when a row menu item is clicked', async () => {
    const { onFocusTerminal, container } = await mount(SessionsFixtures.mixed())
    showAll(container)
    const row = container.querySelector('[data-session="s-working"] > .jamat-sessions__row')
    if (!(row instanceof HTMLElement))
      throw new Error('The tree drew no working session row')
    fireEvent.contextMenu(row)
    onFocusTerminal.mockClear()

    clickMenuItem('Fork session')

    expect(onFocusTerminal).not.toHaveBeenCalled()
  })

  // The one thing in here that IS typed into keeps what the click just gave it.
  it('leaves the filter box the caret it was clicked for', async () => {
    const { onFocusTerminal, container } = await mount(SessionsFixtures.mixed())

    const filter = container.querySelector('.jamat-sessions__filter')
    if (!filter) throw new Error('the tree has no filter box')
    fireEvent.click(filter)

    expect(onFocusTerminal).not.toHaveBeenCalled()
  })

  it('leaves the project open when its launch button is pressed', async () => {
    const { container } = await mount(SessionsFixtures.mixed())
    showAll(container)
    const launch = labelled(container, '+ Session in AppJamatV3')
    const twisty = launch.closest('.jamat-sessions__group-row')
      ?.querySelector('.jamat-sessions__group')

    fireEvent.click(launch)

    // The launch buttons sit BESIDE the twisty rather than inside it, so pressing one is not also a
    // press on the row that folds it away - and a button inside a button is not markup a browser keeps.
    expect(twisty?.getAttribute('aria-expanded')).toBe('true')
  })

  it('offers no launch on an ad-hoc row, which has no category to start in', async () => {
    const { container } = await mount(SessionsFixtures.mixed())
    showAll(container)

    expect(container.textContent).toContain('Scratch')
    // The sessions tree alone: the tabs tree below it draws the same project rows again, for the
    // projects whose tabs are in it.
    expect(namesIn(partOf(container, 0)).map(([name]) => name))
      .toEqual([
        '+ Session in NodeJs',
        '+ Session in AppJamatV3',
        '+ Session in Web',
        '+ Session in WebJamatAdmin',
      ])
  })

  it('draws no aggregate number on a project row', async () => {
    const { container } = await mount(SessionsFixtures.setupPending())

    expect(container.querySelector('.jamat-sessions__count')).toBeNull()
  })

  it('says a session is waiting on its install and draws the install underneath it', async () => {
    const { container } = await mount(SessionsFixtures.setupPending())

    expect(container.querySelector('[data-session="s-primary"] [data-setup]')?.textContent)
      .toBe('installing…')
    expect(container.querySelector('[data-session="s-primary"] [data-session="s-install"]'))
      .toBeTruthy()
    // The waiting session is still `starting`: what the install is doing is a second sentence.
    expect(container.querySelector('[data-session="s-primary"] > .jamat-sessions__row [data-glyph]')
      ?.getAttribute('data-glyph')).toBe('starting')
  })

  describe('a retry the project can refuse', () => {
    /*
     * `setup-not-acknowledged` is the one refusal on this panel a person can ANSWER, and until this
     * block existed there was nowhere to answer it: the create path's agreement blocks live in the
     * launcher, and a failed install lives here. The only way out was starting an unrelated worktree
     * session to re-agree to the same commands.
     */
    function refusing(ports: { answers: Map<string, IpcResult<SessionsOpResult>> }): void {
      ports.answers.set('retrySetup:s-failed', {
        ok: true,
        value: {
          ok: false,
          code: 'setup-not-acknowledged',
          detail: 'this project asks to run its own setup',
          setup: { commands: ['pnpm install', 'pnpm build'], hash: 'hash-9' },
        },
      })
    }

    it('shows the commands it is asking about instead of a failure line', async () => {
      const { ports, container } = await mount(SessionsFixtures.setupOutcomes())
      showAll(container)
      refusing(ports)

      chooseSessionMenuAction(container, 's-failed', 'Retry setup')

      await waitFor(() =>
        expect(container.querySelector('.jamat-sessions__setup-ask')).not.toBeNull())
      const asking = container.querySelector('.jamat-sessions__setup-ask')
      expect(asking?.textContent).toContain('pnpm install')
      expect(asking?.textContent).toContain('pnpm build')
      // A question is not a failure, and the red line is what a failure looks like here.
      expect(container.querySelector('.jamat-sessions__error')).toBeNull()
    })

    it('answers with the hash it was given, and only with that one', async () => {
      const { ports, container } = await mount(SessionsFixtures.setupOutcomes())
      showAll(container)
      refusing(ports)

      chooseSessionMenuAction(container, 's-failed', 'Retry setup')
      await waitFor(() =>
        expect(container.querySelector('.jamat-sessions__setup-ask')).not.toBeNull())
      fireEvent.click(screen.getByText('Run these commands'))

      await waitFor(() => expect(ports.calls).toContain('retrySetup:s-failed:hash-9'))
      expect(ports.calls).toEqual(['retrySetup:s-failed', 'retrySetup:s-failed:hash-9'])
      expect(container.querySelector('.jamat-sessions__setup-ask')).toBeNull()
    })

    it('takes the question away again when it is cancelled', async () => {
      const { ports, container } = await mount(SessionsFixtures.setupOutcomes())
      showAll(container)
      refusing(ports)

      chooseSessionMenuAction(container, 's-failed', 'Retry setup')
      await waitFor(() =>
        expect(container.querySelector('.jamat-sessions__setup-ask')).not.toBeNull())
      fireEvent.click(screen.getByText('Cancel'))

      expect(container.querySelector('.jamat-sessions__setup-ask')).toBeNull()
      expect(ports.calls).toEqual(['retrySetup:s-failed'])
    })

    /*
     * The payload is data off the wire, and the CODE is what says it is a question. A refusal that
     * carries a setup block under any other code is still a failure: this panel does not decide
     * that something is answerable by finding a field it recognises.
     */
    it('reads only that one code as a question, however the payload looks', async () => {
      const { ports, container } = await mount(SessionsFixtures.setupOutcomes())
      showAll(container)
      ports.answers.set('retrySetup:s-failed', {
        ok: true,
        value: {
          ok: false,
          code: 'launch-pending',
          detail: 'a launch is already waiting',
          setup: { commands: ['pnpm install'], hash: 'hash-9' },
        } as SessionsOpResult,
      })

      chooseSessionMenuAction(container, 's-failed', 'Retry setup')

      await waitFor(() =>
        expect(container.querySelector('.jamat-sessions__error')?.textContent)
          .toContain('a launch is already waiting'))
      expect(container.querySelector('.jamat-sessions__setup-ask')).toBeNull()
    })

    /** Every other refusal is still a failure line: only this one code is a question. */
    it('writes an ordinary refusal into the error line as before', async () => {
      const { ports, container } = await mount(SessionsFixtures.setupOutcomes())
      showAll(container)
      ports.answers.set('retrySetup:s-failed', {
        ok: true,
        value: { ok: false, code: 'launch-pending', detail: 'a launch is already waiting' },
      })

      chooseSessionMenuAction(container, 's-failed', 'Retry setup')

      await waitFor(() =>
        expect(container.querySelector('.jamat-sessions__error')?.textContent)
          .toContain('a launch is already waiting'))
      expect(container.querySelector('.jamat-sessions__setup-ask')).toBeNull()
    })
  })

  it('names both outcomes an install can leave behind', async () => {
    const { container } = await mount(SessionsFixtures.setupOutcomes())

    showAll(container)

    expect(container.querySelector('[data-session="s-failed"] [data-setup]')?.textContent)
      .toBe('install failed')
    expect(container.querySelector('[data-session="s-skipped"] [data-setup]')?.textContent)
      .toBe('∅')
    expect(container.querySelector('[data-session="s-failed"] [data-session="s-failed-install"]'))
      .toBeTruthy()
  })

  it('draws a worktree diff only where something has measured one', async () => {
    const { container } = await mount(SessionsFixtures.mixed())

    const measured = container.querySelector('[data-session="s-working"] .jamat-sessions__worktree')
    expect(measured?.textContent).toBe('+12 -3BASE')
    const unmeasured = container
      .querySelector('[data-session="s-waiting"] .jamat-sessions__worktree')
    expect(unmeasured?.textContent).toBe('')
  })

  it('collapses a root and takes its sessions off the screen with it', async () => {
    const { container } = await mount(SessionsFixtures.mixed())
    const root = buttonNamed(container, '▾AD-HOC')

    fireEvent.click(root)

    expect(container.querySelector('[data-session="s-adhoc"]')).toBeNull()
    expect(container.querySelector('[data-session="s-working"]')).toBeTruthy()
  })

  it('says so when a filter matches nothing at all', async () => {
    const { container } = await mount(SessionsFixtures.mixed())
    const filter = container.querySelector('.jamat-sessions__filter')
    if (!(filter instanceof HTMLInputElement))
      throw new Error('The tree drew no filter field')

    fireEvent.change(filter, { target: { value: 'nothing matches this' } })

    expect(container.querySelector('.jamat-sessions__empty')?.textContent)
      .toBe('No session matches this filter.')
  })

  /**
   * The row's menu, aimed at the CLICKED session - which needs no open tab in this window. Which
   * items it holds is the menu component's own test; what this holds is the wiring: right-click
   * opens it, and what runs from it names the row's session.
   */
  it('opens a menu on right-click and runs the clicked command on that row session', async () => {
    const { container, commands } = await mount(SessionsFixtures.mixed())
    const execute = vi.spyOn(commands, 'execute')
    const row = container.querySelector('[data-session="s-working"] > .jamat-sessions__row')
    if (!(row instanceof HTMLElement))
      throw new Error('The tree drew no working session row')

    fireEvent.contextMenu(row)
    expect(document.querySelector('.jamat-tab-menu')).toBeTruthy()

    const fork = [...document.querySelectorAll('.jamat-tab-menu .jamat-context-menu__label')]
      .find((label) => label.textContent === 'Fork session')
    if (!(fork instanceof HTMLElement))
      throw new Error('The menu offers no fork')
    fireEvent.click(fork)

    expect(execute.mock.calls).toEqual([['session.fork', { sessionId: 's-working' }]])
    expect(document.querySelector('.jamat-tab-menu')).toBeNull()
  })

  /**
   * A paired computer's row runs the SAME catalog command a local row does, with the endpoint beside
   * the session: what is copied is composed from the snapshot this computer already holds, so there
   * is nothing a second command would do differently.
   */
  it('runs the one shared command from a remote row, naming the endpoint beside the session', async () => {
    const mixed = SessionsFixtures.mixed()
    const { container, commands } = await mount(
      mixed,
      null,
      remoteSnapshot([outboundEndpoint(mixed, 'endpoint-a')]),
    )
    const execute = vi.spyOn(commands, 'execute')
    showAll(container)
    const remote = sectionAfter(container, 'Remote')
    const row = rowOf(remote, TerminalTargetCodec.key({
      kind: 'remote', remoteEndpointId: 'endpoint-a', sessionId: 's-working',
    }))

    fireEvent.contextMenu(row)
    clickMenuItem('Copy unique session id')

    expect(execute.mock.calls).toEqual([['session.copyReference', {
      sessionId: 's-working',
      remoteEndpointId: 'endpoint-a',
    }]])
  })

  /**
   * The rows ABOVE a session answer a right-click too, and with what that row knows: a project names
   * both halves of a place, a category only its own. Which items each holds is the group menu's own
   * test; what these hold is the wiring - which row opens which menu, and what it sends.
   */
  it('opens a menu on a project row and sends that project as the place', async () => {
    const { container, commands } = await mount(SessionsFixtures.mixed())
    const execute = vi.spyOn(commands, 'execute')

    fireEvent.contextMenu(groupRowLabelled(container, 'AppJamatV3'))
    clickMenuItem('New session…')

    expect(execute.mock.calls).toEqual([['session.newHere', {
      place: {
        kind: 'project',
        project: {
          kind: 'project',
          categoryId: 'nodejs',
          projectName: 'AppJamatV3',
          projectPath: 'C:/Projects/NodeJs/AppJamatV3',
        },
      },
    }]])
    expect(document.querySelector('.jamat-tab-menu')).toBeNull()
  })

  it('opens a menu on a category row and sends the category alone', async () => {
    const { container, commands } = await mount(SessionsFixtures.mixed())
    const execute = vi.spyOn(commands, 'execute')

    fireEvent.contextMenu(groupRowLabelled(container, 'NodeJs'))
    clickMenuItem('New session…')

    expect(execute.mock.calls)
      .toEqual([['session.newHere', { place: { kind: 'category', categoryId: 'nodejs' } }]])
  })

  // The path is the row's own; the session is only what the directory grant is proved against.
  it('sends the project row path with one of its sessions to open the folder with', async () => {
    const { container, commands } = await mount(SessionsFixtures.mixed())
    const execute = vi.spyOn(commands, 'execute')

    fireEvent.contextMenu(groupRowLabelled(container, 'AppJamatV3'))
    clickMenuItem('Open project folder')

    expect(execute.mock.calls).toEqual([['project.openFolder', {
      path: 'C:/Projects/NodeJs/AppJamatV3',
      sessionId: 's-working',
    }]])
  })

  /**
   * The two roots the catalog does not name hold no place and no path, so their menu would be empty
   * - and an empty box under the cursor says less than a right-click that does nothing.
   */
  it('opens no menu at all on the AD-HOC root', async () => {
    const { container } = await mount(SessionsFixtures.mixed())
    showAll(container)

    fireEvent.contextMenu(groupRowLabelled(container, 'AD-HOC'))

    expect(document.querySelector('.jamat-tab-menu')).toBeNull()
  })

  // An ad-hoc directory belongs to no category, so there is nothing for the launcher to pre-bind to.
  it('offers a project row of no category its folder and no new session', async () => {
    const { container } = await mount(SessionsFixtures.mixed())
    showAll(container)

    fireEvent.contextMenu(groupRowLabelled(container, 'Scratch'))

    expect(menuTitles()).toEqual(['Open project folder', 'Copy project folder'])
  })

  /**
   * The row gained no symbol for any of this: the two dots are gone and what they said is in the
   * character before the name. A dot left anywhere would be the redundancy this change removed.
   */
  it('draws no dot on any row', async () => {
    const mixed = SessionsFixtures.mixed()
    const { ports, container } = await mount(mixed)
    const working = withActivity(mixed, ['s-working'], 'working')
    ports.push(working)
    await waitFor(() =>
      expect(glyphOf(container, 's-working')?.getAttribute('data-glyph')).toBe('working'))
    ports.push(withActivity(working, ['s-working'], 'idle'))
    await waitFor(() => expect(markedOf(container, 's-working')).toBe(true))

    expect(container.querySelector('.jamat-sessions__dot')).toBeNull()
  })

  /**
   * The one place the unseen mark is not on the character. A lost runtime is drawn in danger, which
   * outranks everything, so the pill that row already carries says whether anybody has looked yet.
   */
  it('dims the interrupted pill once the lost session has been seen', async () => {
    const mixed = SessionsFixtures.mixed()
    const { container } = await mount(mixed)
    showAll(container)

    // Lost at its first sighting raises nothing - a baseline is not news - so this one reads as seen.
    const pill = container.querySelector(
      '[data-session="s-lost"] > .jamat-sessions__row .jamat-sessions__pill--interrupted',
    )
    expect(pill?.className).toContain('jamat-sessions__pill--interrupted-seen')
    expect(pill?.getAttribute('title'))
      .toBe("The session's runtime disappeared without exiting")
  })

  it('leaves the interrupted pill loud on a runtime that died while nobody looked', async () => {
    const mixed = SessionsFixtures.mixed()
    const { ports, container } = await mount(mixed)
    ports.push({
      ...mixed,
      revision: mixed.revision + 1,
      sessions: mixed.sessions.map((session) => session.sessionId === 's-working'
        ? { ...session, life: 'lost' as const }
        : session),
    })
    await waitFor(() => expect(
      container.querySelector('[data-session="s-working"] .jamat-sessions__pill--interrupted'),
    ).toBeTruthy())
    showAll(container)

    const pill = container.querySelector(
      '[data-session="s-working"] > .jamat-sessions__row .jamat-sessions__pill--interrupted',
    )
    expect(pill?.className).not.toContain('jamat-sessions__pill--interrupted-seen')
    expect(pill?.getAttribute('title'))
      .toBe("The session's runtime disappeared without exiting - not seen since")
  })

  /**
   * The mark sits in the slot the two dots left behind, so the row carries the same number of things
   * it did before. It names the VCS, because "commit this" means two different commands here.
   */
  it('marks a row whose working copy has uncommitted work, and names the VCS', async () => {
    const { container } = await mount(SessionsFixtures.stoppedWorktree())

    const mark = container.querySelector(
      '[data-session="s-dirty"] > .jamat-sessions__row .jamat-sessions__vcs',
    )
    expect(mark?.textContent).toBe('*')
    expect(mark?.getAttribute('title')).toBe('Uncommitted changes (git)')
    expect(container.querySelector(
      '[data-session="s-clean"] > .jamat-sessions__row .jamat-sessions__vcs',
    )).toBeNull()
  })

  /**
   * Every mark says what it means when it is pointed at. Several of these carried nothing at all,
   * which on a row that is mostly one-word chips is the difference between a legend and a guess.
   */
  it('gives every mark on the row something to say', async () => {
    const { container } = await mount(SessionsFixtures.stoppedWorktree())
    const titleOf = (sessionId: string, selector: string): string | null | undefined =>
      container.querySelector(`[data-session="${sessionId}"] > .jamat-sessions__row ${selector}`)
        ?.getAttribute('title')

    expect(titleOf('s-dirty', '.jamat-sessions__worktree')).toBe('Branch jamat/dirty')
    expect(titleOf('s-dirty', '.jamat-sessions__vcs')).toBe('Uncommitted changes (git)')
    expect(titleOf('s-dirty', '.jamat-sessions__glyph')).toBe('ended')
  })

  it('explains the base chip, the pills and the merge word', async () => {
    const { container } = await mount(SessionsFixtures.mixed())
    showAll(container)
    const titlesOf = (selector: string): (string | null)[] =>
      [...container.querySelectorAll(selector)].map((mark) => mark.getAttribute('title'))

    // Counted, not just iterated: an empty result would pass a loop over nothing.
    const tabPills = titlesOf('.jamat-sessions__pill--tab')
    expect(tabPills.length).toBeGreaterThan(0)
    for (const title of tabPills)
      expect(title).toBe("Lives only as a tab; not part of the tree's flows")

    const completed = titlesOf('.jamat-sessions__pill--completed')
    expect(completed.length).toBeGreaterThan(0)
    for (const title of completed)
      expect(title).toBe('Marked completed by you')
  })

  it('explains what a moved base means', async () => {
    const { container } = await mount(SessionsFixtures.mixed())

    const base = container.querySelector('.jamat-sessions__base')
    expect(base?.getAttribute('title'))
      .toBe('The branch this worktree was cut from has moved on')
  })
})
