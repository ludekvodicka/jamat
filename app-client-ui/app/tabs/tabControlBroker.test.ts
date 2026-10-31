import { afterEach, describe, expect, it, vi } from 'vitest'

import type { TabControlAck, TabControlCommand } from '../../shared/tabControl'
import type { WorkspaceWindows } from '../shell/workspaceWindows'
import type { VersioningCommitManager } from '../versioning/versioningCommitManager'
import { AttentionQueue } from '../attention/attentionQueue'
import { TabControlBroker, type TabControlBrokerDeps } from './tabControlBroker'
import type { TabFileOpenResolution } from './tabFileOpenResolver'
import { WorkspacePanelIndex } from './workspacePanelIndex'

class FakeWindows {
  focusedWindowId: string | null = 'main'
  lastFocusedWindowId = 'main'
  readonly accepted = new Set(['main', 'holder'])
  readonly focused: string[] = []
  readonly published: { windowId: string; command: TabControlCommand }[] = []
  readonly blocked = new Map<string, Promise<void>>()

  acceptsWindow(windowId: string): boolean {
    return this.accepted.has(windowId)
  }

  focusOrRecreate(windowId: string): void {
    if (!this.accepted.has(windowId))
      throw new Error(`Unknown window: ${windowId}`)
    this.focused.push(windowId)
    this.focusedWindowId = windowId
    this.lastFocusedWindowId = windowId
  }

  focusedWorkspace(): { windowId: string } | null {
    return this.focusedWindowId === null ? null : { windowId: this.focusedWindowId }
  }

  lastFocusedWorkspace(): { windowId: string } {
    return { windowId: this.focusedWindowId ?? this.lastFocusedWindowId }
  }

  whenRendererReady(windowId: string): Promise<void> {
    return this.blocked.get(windowId) ?? Promise.resolve()
  }

  publishTo(windowId: string, channel: string, command: TabControlCommand): void {
    if (channel !== 'tabs:control-command')
      throw new Error(`Unknown event: ${channel}`)
    this.published.push({ windowId, command })
  }

  asWindows(): WorkspaceWindows {
    return this as unknown as WorkspaceWindows
  }
}

/** The broker with the real attention queue behind it, as AppHub composes the two. */
class TabControlHarness {
  readonly windows = new FakeWindows()
  readonly index = new WorkspacePanelIndex()
  readonly resolver = new FakeFileOpenResolver()
  readonly commits = {
    prepare: vi.fn<import('../versioning/versioningCommitManager').VersioningCommitManager['prepare']>(async () => ({ ok: true,
      value: { draftId: 'draft', scopeRoot: 'Q:/app/shared', title: 'Commit SVN' }, messageApplied: false })),
    attach: vi.fn(), releaseUnattached: vi.fn(), status: vi.fn<VersioningCommitManager['status']>(() => null),
    cancel: vi.fn<VersioningCommitManager['cancel']>(async () => ({ ok: false, error: { code: 'not-found', detail: 'Unknown review' } })),
    reviews: vi.fn<VersioningCommitManager['reviews']>(() => []),
  }
  readonly attention: AttentionQueue
  readonly broker: TabControlBroker
  readonly drafts = new Map<string, NonNullable<ReturnType<VersioningCommitManager['status']>>>()
  readonly reports: string[] = []
  private nextRequest = 0

  /** Milliseconds, advanced by a test that wants the queue to see a review it sat in. */
  clock = 0
  /** The quiet time before an agent's item comes forward; 0 brings it while a workspace has the focus. */
  idleMilliseconds = 0
  activateDocuments = false

  constructor(timeoutMilliseconds = 1_000, activateSessionOnCommit = true, returnToPreviousSessionAfterCommit = true,
    returnWindowMilliseconds: number | null = 300_000, recordOpen?: TabControlBrokerDeps['recordOpen']) {
    this.attention = new AttentionQueue({
      front: () => {
        const focused = this.windows.focusedWorkspace()
        return focused === null ? null : { panelId: this.activePanel(focused.windowId) }
      },
      lastActivePanel: () => this.activePanel(this.windows.lastFocusedWorkspace().windowId),
      focus: async (panelId) => { await this.broker.focus(panelId) },
      idleMilliseconds: () => this.idleMilliseconds,
      returnEnabled: () => returnToPreviousSessionAfterCommit,
      returnWindowMilliseconds: () => returnWindowMilliseconds,
      onChanged: () => {},
      report: (message) => this.reports.push(message),
      now: () => this.clock,
    })
    this.broker = new TabControlBroker(
      this.windows.asWindows(),
      this.index,
      this.resolver,
      this.commits,
      this.attention,
      {
        recordOpen,
        requestId: () => `request-${++this.nextRequest}`,
        timeoutMilliseconds,
        activateSessionOnCommit: () => activateSessionOnCommit,
        activateSessionOnDocument: () => this.activateDocuments,
      },
    )
  }

  async command(index = 0): Promise<TabControlCommand> {
    await vi.waitFor(() => expect(this.windows.published.length).toBeGreaterThan(index))
    const published = this.windows.published[index]
    if (!published)
      throw new Error(`No published command at ${index}`)
    return published.command
  }

  acknowledge(windowId: string, command: TabControlCommand, result: TabControlAck['result']): void {
    this.broker.acknowledge(windowId, { requestId: command.requestId, result })
  }

  session(panelId: string, windowId = 'main'): void {
    this.index.claimOpen(windowId, { panelId, key: 'terminal', title: panelId,
      sessionId: panelId, params: { sessionId: panelId } })
    this.index.setActivePanel(windowId, panelId)
  }

  status(state: NonNullable<ReturnType<VersioningCommitManager['status']>>['state'], closed = false): void {
    this.commits.status.mockReturnValue({ kind: 'commit-status', commitSessionId: 'draft', sessionId: 'commit',
      vcs: 'svn', scopeRoot: 'Q:/app/shared', state, closed, revision: state === 'committed' ? '123' : null, detail: null })
  }

  /** The agent's open behind the tab in front, then the queue bringing it forward when `shown`. */
  async openReview(options: { showRefusal?: true } = {}, shown = true): Promise<void> {
    const commandIndex = this.windows.published.length
    const pending = this.broker.openCommit('commit', 'Commit', 'svn', null, null, options)
    this.acceptReview(await this.command(commandIndex))
    expect((await pending).ok).toBe(true)
    if (shown) {
      const activation = await this.command(commandIndex + 1)
      expect(activation).toMatchObject({ kind: 'open-commit', panelId: 'commit', activate: true, existingOnly: true })
      this.acceptReview(activation)
    }
  }

  async queueReview(sessionId: string, draftId: string, paths?: readonly string[]): Promise<void> {
    const scopeRoot = `Q:/app/${draftId}`
    this.commits.prepare.mockResolvedValue({ ok: true, value: { draftId, scopeRoot, title: `Commit ${draftId}`, paths }, messageApplied: true })
    if (!this.drafts.has(draftId))
      this.drafts.set(draftId, { kind: 'commit-status', commitSessionId: draftId, sessionId, vcs: 'svn', scopeRoot,
        state: 'editing', closed: false, revision: null, detail: null })
    this.commits.status.mockImplementation((id) => this.drafts.get(id) ?? null)
    const commandIndex = this.windows.published.length
    const pending = this.broker.openCommit(sessionId, sessionId, 'svn', scopeRoot, null, { paths })
    const command = await this.command(commandIndex)
    expect(command).toMatchObject({ kind: 'open-commit', panelId: sessionId, activate: false })
    this.acceptReview(command)
    expect(await pending).toMatchObject({ ok: true, value: { commitSessionId: draftId } })
  }

  acceptReview(command: TabControlCommand): void {
    if (command.kind !== 'open-commit') throw new Error(`Expected review: ${command.kind}`)
    const windowId = this.index.ownerOf(command.panelId)!
    if (command.activate) this.index.setActivePanel(windowId, command.panelId)
    this.acknowledge(windowId, command, { kind: 'commit-opened', panelId: command.panelId })
  }

  finishReview(draftId: string, state: NonNullable<ReturnType<VersioningCommitManager['status']>>['state'] = 'committed', closed = false): void {
    const previous = this.drafts.get(draftId)
    if (previous === undefined) throw new Error(`Missing review: ${draftId}`)
    this.drafts.set(draftId, { ...previous, state, closed })
    this.broker.commitsChanged()
  }

  async settled(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }

  stop(): void {
    this.broker.cancelAll()
    this.attention.stop()
  }

  private activePanel(windowId: string): string | null {
    return this.index.snapshot().find((panel) => panel.windowId === windowId && panel.active)?.panelId ?? null
  }
}

class FakeFileOpenResolver {
  readonly calls: { sessionId: string; path: string }[] = []
  answer: TabFileOpenResolution = {
    ok: true,
    source: {
      kind: 'workspace',
      sessionId: 'session-1',
      path: 'Q:\\Apps\\Project\\reports\\report.md',
    },
    documentKey: 'document-report',
    title: 'report.md',
  }

  resolve(sessionId: string, path: string): Promise<TabFileOpenResolution> {
    this.calls.push({ sessionId, path })
    return Promise.resolve(this.answer)
  }
}

describe('app-client-ui/app/tabs/tabControlBroker', () => {
  it.each([true, false])('projects remote reviews behind the active tab, queued=%s, and consumes each open once', async (queued) => {
    const h = new TabControlHarness(1000, queued)
    h.session('previous')
    const target = { kind: 'remote' as const, remoteEndpointId: 'peer', sessionId: 'session' }
    h.index.claimOpen('main', { panelId: 'remote', key: 'terminal', title: 'Remote', sessionId: null, params: { target } })
    const draft: import('../../shared/versioningCommit').VersioningCommitDraftDto = { draftId: 'review', sessionId: 'session', vcs: 'svn', source: 'svn', scopeRoot: 'Q:/app', scopeTooltip: 'Q:/app', message: 'Human', proposedByAgent: false, editedByPerson: true, phase: { kind: 'editing' }, revision: 1 }
    const first = h.broker.projectReview(target, draft, 'item', 'open-1')
    const command = await h.command()
    expect(command).toMatchObject({ kind: 'open-commit', activate: false, reviewId: 'review', openId: 'open-1' })
    h.acceptReview(command)
    await first
    if (queued) {
      const shown = await h.command(1)
      expect(shown).toMatchObject({ kind: 'open-commit', panelId: 'remote', activate: true, existingOnly: true })
      h.acceptReview(shown)
    }
    const opened = h.windows.published.length
    await h.broker.projectReview(target, draft, 'item', 'open-1')
    expect(h.windows.published).toHaveLength(opened)
    h.broker.updateProjectedReview(target, draft, true)
    if (queued) {
      const back = await h.command(opened)
      expect(back).toMatchObject({ kind: 'focus-panel', panelId: 'previous' })
      h.index.setActivePanel('main', 'previous')
      h.acknowledge('main', back, { kind: 'focused', panelId: 'previous' })
    }
    await h.settled()
    const count = h.windows.published.length
    await h.broker.projectReview(target, draft, 'item', 'open-1')
    expect(h.windows.published).toHaveLength(count)
    const reopened = h.broker.projectReview(target, draft, 'item', 'open-2')
    const fresh = await h.command(count)
    expect(fresh).toMatchObject({ activate: false, openId: 'open-2' })
    h.acceptReview(fresh)
    await reopened
    h.stop()
  })

  it('lists review identities on their owning session and waits for cancellation before preparing another', async () => {
    const h = new TabControlHarness()
    h.session('commit')
    const review = { kind: 'commit-status' as const, commitSessionId: 'draft', sessionId: 'commit', vcs: 'svn' as const,
      scopeRoot: 'Q:/app', state: 'editing' as const, closed: false, revision: null, detail: null }
    h.commits.reviews.mockReturnValue([review])
    expect(await h.broker.list()).toMatchObject([{ sessionId: 'commit', commitReviews: [review] }])
    expect(h.commits.reviews).toHaveBeenCalledWith('commit', 'main')
    let finish!: (value: Awaited<ReturnType<VersioningCommitManager['cancel']>>) => void
    h.commits.cancel.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    const cancel = h.broker.cancelCommit('draft')
    const reopen = h.broker.openCommit('commit', 'Commit', 'svn', null, null, {})
    await h.settled()
    expect(h.commits.cancel).toHaveBeenCalledWith('draft')
    expect(h.commits.prepare).not.toHaveBeenCalled()
    finish({ ok: true, value: { ...review, state: 'cancelled', closed: true } })
    expect(await cancel).toMatchObject({ ok: true, value: { state: 'cancelled', closed: true } })
    h.acceptReview(await h.command())
    expect(await reopen).toMatchObject({ ok: true })
    h.stop()
  })

  it('queues reviews across windows in arrival order and returns only after the last one', async () => {
    const h = new TabControlHarness()
    h.session('first')
    h.session('second', 'holder')
    h.session('third')
    h.session('original')
    await h.queueReview('first', 'one')
    const shown = await h.command(1)
    expect(shown).toMatchObject({ kind: 'open-commit', panelId: 'first', activate: true, existingOnly: true, messageApplied: false })
    h.acceptReview(shown)
    await h.queueReview('second', 'two', ['Q:/app/two/a.txt', 'Q:/app/two/b.txt'])
    await h.queueReview('third', 'three')
    await h.settled()
    expect(h.windows.published).toHaveLength(4)
    expect(h.windows.focused).toEqual(['main'])

    h.finishReview('one')
    const second = await h.command(4)
    expect(second).toMatchObject({ kind: 'open-commit', panelId: 'second', scopeRoot: 'Q:/app/two', activate: true,
      paths: ['Q:/app/two/a.txt', 'Q:/app/two/b.txt'], messageApplied: false, existingOnly: true })
    expect(h.windows.published[4]?.windowId).toBe('holder')
    h.acceptReview(second)
    h.finishReview('two', 'cancelled', true)
    const third = await h.command(5)
    expect(third).toMatchObject({ kind: 'open-commit', panelId: 'third', activate: true })
    h.acceptReview(third)
    h.finishReview('three')
    const returned = await h.command(6)
    expect(returned).toMatchObject({ kind: 'focus-panel', panelId: 'original' })
    h.acknowledge('main', returned, { kind: 'focused', panelId: 'original' })
    h.broker.commitsChanged()
    await h.settled()
    expect(h.windows.published).toHaveLength(7)
    expect(h.commits.prepare).toHaveBeenCalledTimes(3)
  })

  it('deduplicates reopened waiting reviews without reactivating them', async () => {
    const h = new TabControlHarness()
    h.session('first')
    h.session('second')
    h.session('original')
    await h.queueReview('first', 'one')
    h.acceptReview(await h.command(1))
    await h.queueReview('second', 'two')
    await h.queueReview('second', 'two')
    await h.queueReview('first', 'one')
    await h.settled()
    expect(h.windows.published).toHaveLength(5)
    expect(h.windows.focused).toEqual(['main'])
    h.finishReview('one')
    const next = await h.command(5)
    expect(next).toMatchObject({ panelId: 'second', activate: true })
    h.acceptReview(next)
    h.finishReview('two')
    const returned = await h.command(6)
    expect(returned).toMatchObject({ kind: 'focus-panel', panelId: 'original' })
    h.acknowledge('main', returned, { kind: 'focused', panelId: 'original' })
  })

  /*
   * The review left unfinished stays open in its tab and no longer holds anything; the one waiting
   * behind it is the next in the queue, so it comes forward before the newer one.
   */
  it.each(['other-session', 'other-window', 'other-app'] as const)(
    'brings the next waiting review forward after the person leaves an unfinished one for %s', async (move) => {
      const h = new TabControlHarness()
      h.session('first')
      h.session('second')
      h.session('third')
      h.session('original')
      await h.queueReview('first', 'one')
      h.acceptReview(await h.command(1))
      await h.queueReview('second', 'two')
      const windowId = move === 'other-window' ? 'holder' : 'main'
      h.session('other', windowId)
      h.windows.lastFocusedWindowId = windowId
      h.windows.focusedWindowId = move === 'other-app' ? null : windowId
      h.clock = 300_001

      await h.queueReview('third', 'three')
      if (move === 'other-app') {
        await h.settled()
        expect(h.windows.published).toHaveLength(4)
        h.windows.focusedWindowId = windowId
        h.attention.personActive()
      }

      const two = await h.command(4)
      expect(two).toMatchObject({ panelId: 'second', activate: true })
      h.acceptReview(two)
      h.finishReview('one')
      await h.settled()
      expect(h.windows.published).toHaveLength(5)
      h.finishReview('two')
      const three = await h.command(5)
      expect(three).toMatchObject({ panelId: 'third', activate: true })
      h.acceptReview(three)
      h.finishReview('three')
      const returned = await h.command(6)
      expect(returned).toMatchObject({ kind: 'focus-panel', panelId: 'other' })
      h.acknowledge(windowId, returned, { kind: 'focused', panelId: 'other' })
    },
  )

  it.each(['first', 'second'] as const)('brings the oldest waiting review forward when the %s is reopened after leaving', async (sessionId) => {
    const h = new TabControlHarness()
    h.session('first')
    h.session('second')
    h.session('original')
    await h.queueReview('first', 'one')
    h.acceptReview(await h.command(1))
    await h.queueReview('second', 'two')
    h.index.setActivePanel('main', 'original')

    await h.queueReview(sessionId, sessionId === 'first' ? 'one' : 'two')

    expect(await h.command(4)).toMatchObject({ panelId: 'second', activate: true })
    h.stop()
  })

  it.each(['failed', 'running', 'external-closed'] as const)('holds the queue while the current review is %s', async (state) => {
    const h = new TabControlHarness()
    h.session('first')
    h.session('second')
    h.session('original')
    await h.queueReview('first', 'one')
    h.acceptReview(await h.command(1))
    await h.queueReview('second', 'two')
    h.finishReview('one', state)
    await h.settled()
    expect(h.windows.published).toHaveLength(3)
    h.finishReview('one')
    h.acceptReview(await h.command(3))
    h.stop()
  })

  it.each(['cancelled', 'committed', 'unknown', 'closed-tab'] as const)('skips a waiting review that is already %s', async (state) => {
    const h = new TabControlHarness()
    h.session('first')
    h.session('second')
    h.session('third')
    h.session('original')
    await h.queueReview('first', 'one')
    h.acceptReview(await h.command(1))
    await h.queueReview('second', 'two')
    await h.queueReview('third', 'three')
    if (state === 'cancelled') h.finishReview('two', 'cancelled', true)
    else if (state === 'committed') h.finishReview('two')
    else if (state === 'unknown') h.drafts.delete('two')
    else if (state === 'closed-tab') h.index.release('second', 'main')
    else throw new Error(`Unknown state: ${state}`)
    h.finishReview('one')
    const next = await h.command(4)
    expect(next).toMatchObject({ panelId: 'third', activate: true })
    h.acceptReview(next)
    h.stop()
  })

  it.each(['disabled', 'expired'] as const)('still advances the queue when the final return is %s', async (mode) => {
    const h = new TabControlHarness(1_000, true, mode !== 'disabled')
    h.session('first')
    h.session('second')
    h.session('original')
    await h.queueReview('first', 'one')
    h.acceptReview(await h.command(1))
    h.clock = 300_001
    await h.queueReview('second', 'two')
    h.finishReview('one')
    h.acceptReview(await h.command(3))
    h.finishReview('two')
    await h.settled()
    expect(h.windows.published).toHaveLength(4)
  })

  it.each(['other-session', 'other-app'] as const)('does not move on when a review ends after the person moved to %s', async (move) => {
    const h = new TabControlHarness()
    h.idleMilliseconds = 20_000
    h.session('first')
    h.session('second')
    h.session('original')
    await h.queueReview('first', 'one')
    h.acceptReview(await h.command(1))
    await h.queueReview('second', 'two')
    if (move === 'other-session') h.session('other')
    else if (move === 'other-app') h.windows.focusedWindowId = null
    else throw new Error(`Unknown move: ${move}`)
    h.attention.personActive()
    h.finishReview('one')
    await h.settled()
    expect(h.windows.published).toHaveLength(3)
    h.finishReview('two')
    await h.settled()
    expect(h.windows.published).toHaveLength(3)
    h.stop()
  })

  it('uses the current owner when the next review tab has moved', async () => {
    const h = new TabControlHarness()
    h.session('first')
    h.session('second')
    h.session('original')
    await h.queueReview('first', 'one')
    h.acceptReview(await h.command(1))
    await h.queueReview('second', 'two')
    h.index.release('second', 'main')
    h.session('second', 'holder')
    h.index.setActivePanel('main', 'first')
    h.finishReview('one')
    const next = await h.command(3)
    expect(h.windows.published[3]?.windowId).toBe('holder')
    h.acceptReview(next)
    h.stop()
  })

  it('drops a review whose activation the renderer refuses, and the next one waits for the quiet time', async () => {
    const h = new TabControlHarness()
    h.session('first')
    h.session('second')
    h.session('third')
    h.session('original')
    await h.queueReview('first', 'one')
    h.acceptReview(await h.command(1))
    await h.queueReview('second', 'two')
    await h.queueReview('third', 'three')
    h.idleMilliseconds = 20_000
    h.finishReview('one')
    const next = await h.command(4)
    h.acknowledge('main', next, { kind: 'failed', detail: 'The renderer cannot activate the review' })
    await h.settled()
    h.finishReview('two')
    await h.settled()
    expect(h.windows.published).toHaveLength(5)
    expect(h.attention.snapshot().items.map((item) => item.key)).toEqual(['three'])
    h.stop()
  })

  it('keeps simultaneous opens ordered while the first renderer acknowledgement is pending', async () => {
    const h = new TabControlHarness()
    h.session('first')
    h.session('second')
    h.session('original')
    h.commits.prepare.mockImplementation(async (sessionId) => ({ ok: true,
      value: { draftId: sessionId, scopeRoot: `Q:/app/${sessionId}`, title: sessionId }, messageApplied: false }))
    h.status('editing')
    const first = h.broker.openCommit('first', 'First', 'svn', null, null, {})
    const second = h.broker.openCommit('second', 'Second', 'svn', null, null, {})
    const command = await h.command()
    expect(command).toMatchObject({ panelId: 'first', activate: false })
    expect(h.commits.prepare).toHaveBeenCalledTimes(1)
    h.acceptReview(command)
    expect((await first).ok).toBe(true)
    await vi.waitFor(() => expect(h.windows.published).toHaveLength(3))
    const queued = h.windows.published.find(({ command: next }) => next.kind === 'open-commit' && next.panelId === 'second')!.command
    expect(queued).toMatchObject({ activate: false })
    h.acceptReview(queued)
    expect((await second).ok).toBe(true)
    expect(h.windows.published.filter(({ command: next }) => next.kind === 'open-commit' && next.activate === true)
      .map(({ command: next }) => next.kind === 'open-commit' ? next.panelId : null)).toEqual(['first'])
    h.stop()
  })

  it('cancels serialized opens when the application is stopping', async () => {
    const h = new TabControlHarness()
    h.session('first')
    h.session('second')
    h.status('editing')
    const first = h.broker.openCommit('first', 'First', 'svn', null, null, {})
    const second = h.broker.openCommit('second', 'Second', 'svn', null, null, {})
    await h.command()
    h.stop()
    expect(await first).toMatchObject({ ok: false, error: { code: 'unavailable' } })
    expect(await second).toMatchObject({ ok: false, error: { code: 'unavailable' } })
    expect(h.commits.prepare).toHaveBeenCalledTimes(1)
    expect(h.commits.releaseUnattached).toHaveBeenCalledWith('draft')
  })

  it('can return to an original file tab after the review sequence', async () => {
    const h = new TabControlHarness()
    h.session('commit')
    h.index.claimOpen('main', { panelId: 'document', key: 'fileViewer', title: 'Document', params: {}, sessionId: null })
    h.index.setActivePanel('main', 'document')
    await h.queueReview('commit', 'one')
    h.acceptReview(await h.command(1))
    h.finishReview('one')
    const command = await h.command(2)
    expect(command).toMatchObject({ kind: 'focus-panel', panelId: 'document' })
    h.acknowledge('main', command, { kind: 'focused', panelId: 'document' })
  })

  it.each([['committed', false], ['cancelled', true], ['failed', true]] as const)(
    'returns across windows after %s (closed: %s), once', async (state, closed) => {
      const h = new TabControlHarness()
      h.session('original')
      h.session('commit', 'holder')
      h.status('editing')
      await h.openReview()
      h.status(state, closed)
      h.broker.commitsChanged()
      const command = await h.command(2)
      expect(command).toMatchObject({ kind: 'focus-panel', panelId: 'original' })
      expect(h.windows.published[2]?.windowId).toBe('main')
      h.acknowledge('main', command, { kind: 'focused', panelId: 'original' })
      h.broker.commitsChanged()
      await h.settled()
      expect(h.windows.published).toHaveLength(3)
    },
  )

  it.each([['editing', false], ['running', false], ['running', true], ['failed', false], ['external-closed', false]] as const)(
    'keeps review visible while %s (closed: %s)', async (state, closed) => {
      const h = new TabControlHarness()
      h.session('commit')
      h.session('original')
      h.status('editing')
      await h.openReview()
      h.status(state, closed)
      h.broker.commitsChanged()
      await h.settled()
      expect(h.windows.published).toHaveLength(2)
    },
  )

  /**
   * The person who reads the diff, thinks about it and commits ten minutes later is no longer being
   * interrupted by the review: the review is the work, and the tab they left ten minutes ago is the
   * interruption. The window is measured from the moment the review came forward.
   */
  it('stops returning once the review has been open longer than the window', async () => {
    const h = new TabControlHarness()
    h.session('commit')
    h.session('original')
    h.status('editing')
    await h.openReview()
    h.clock = 300_001

    h.status('committed')
    h.broker.commitsChanged()

    await h.settled()
    expect(h.windows.published).toHaveLength(2)
  })

  it('still returns at the edge of the window and whenever the window is turned off', async () => {
    for (const [clock, window] of [[300_000, 300_000], [86_400_000, null]] as const) {
      const h = new TabControlHarness(1_000, true, true, window)
      h.session('commit')
      h.session('original')
      h.status('editing')
      await h.openReview()
      h.clock = clock

      h.status('committed')
      h.broker.commitsChanged()

      const command = await h.command(2)
      expect(command).toMatchObject({ kind: 'focus-panel', panelId: 'original' })
      h.acknowledge('main', command, { kind: 'focused', panelId: 'original' })
    }
  })

  it.each(['return-disabled', 'activation-disabled', 'manual', 'same-session'] as const)(
    'does not create a return for %s opens', async (mode) => {
      const h = new TabControlHarness(1_000, mode !== 'activation-disabled', mode !== 'return-disabled')
      h.session('original')
      h.session('commit')
      if (mode !== 'same-session') h.index.setActivePanel('main', 'original')
      h.status('editing')
      const queued = mode !== 'activation-disabled' && mode !== 'manual'
      await h.openReview(mode === 'manual' ? { showRefusal: true } : {}, queued)
      h.index.setActivePanel('main', 'commit')
      h.status('committed')
      h.broker.commitsChanged()
      await h.settled()
      expect(h.windows.published).toHaveLength(queued ? 2 : 1)
    },
  )

  it.each(['other-session', 'other-window', 'other-app', 'closed-origin'] as const)(
    'does not steal focus or reopen the original tab after %s', async (change) => {
      const h = new TabControlHarness()
      h.session('commit')
      h.session('original')
      h.status('editing')
      await h.openReview()
      if (change === 'other-session') h.session('other')
      else if (change === 'other-window') h.windows.focusedWindowId = 'holder'
      else if (change === 'other-app') h.windows.focusedWindowId = null
      else if (change === 'closed-origin') h.index.release('original', 'main')
      else throw new Error(`Unknown navigation: ${String(change)}`)
      h.status('committed')
      h.broker.commitsChanged()
      await h.settled()
      expect(h.windows.published).toHaveLength(2)
    },
  )

  it('keeps the original return destination when a review is opened again', async () => {
    const h = new TabControlHarness()
    h.session('commit')
    h.session('original')
    h.status('editing')
    await h.openReview()
    await h.openReview({}, false)
    await h.settled()
    expect(h.windows.published).toHaveLength(3)
    h.status('cancelled', true)
    h.broker.commitsChanged()
    const command = await h.command(3)
    expect(command).toMatchObject({ kind: 'focus-panel', panelId: 'original' })
    h.acknowledge('main', command, { kind: 'focused', panelId: 'original' })
  })

  it('activates each queued review in the same session before returning', async () => {
    const h = new TabControlHarness()
    h.session('commit')
    h.session('original')
    h.status('editing')
    await h.openReview()
    h.commits.prepare.mockResolvedValue({ ok: true, value: { draftId: 'second', scopeRoot: 'Q:/app/other', title: 'Commit SVN' }, messageApplied: false })
    await h.openReview({}, false)
    h.status('committed')
    const completed = h.commits.status('draft')!
    h.commits.status.mockImplementation((id) => ({ ...completed, commitSessionId: id, state: id === 'second' ? 'editing' : 'committed' }))
    h.broker.commitsChanged()
    const next = await h.command(3)
    expect(next).toMatchObject({ kind: 'open-commit', scopeRoot: 'Q:/app/other', activate: true })
    h.acceptReview(next)
    h.status('committed')
    h.broker.commitsChanged()
    const command = await h.command(4)
    expect(command).toMatchObject({ kind: 'focus-panel', panelId: 'original' })
    h.acknowledge('main', command, { kind: 'focused', panelId: 'original' })
  })

  it('waits while another application is in front and comes forward when a workspace takes the focus', async () => {
    const h = new TabControlHarness()
    h.session('commit')
    h.session('original', 'holder')
    h.windows.lastFocusedWindowId = 'holder'
    h.windows.focusedWindowId = null
    h.status('editing')
    await h.openReview({}, false)
    await h.settled()
    expect(h.windows.published).toHaveLength(1)
    expect(h.windows.focused).toEqual([])

    h.windows.focusedWindowId = 'holder'
    h.attention.personActive()
    const shown = await h.command(1)
    expect(shown).toMatchObject({ kind: 'open-commit', panelId: 'commit', activate: true })
    h.acceptReview(shown)
    h.status('committed')
    h.broker.commitsChanged()
    const command = await h.command(2)
    expect(command).toMatchObject({ kind: 'focus-panel', panelId: 'original' })
    h.acknowledge('holder', command, { kind: 'focused', panelId: 'original' })
  })

  it('opens a new commit session tab behind the active one and returns to that one after the review', async () => {
    const h = new TabControlHarness()
    h.session('original')
    h.status('editing')
    const pending = h.broker.openCommit('commit', 'Commit', 'git', null, null, {})
    const opening = await h.command()
    expect(opening).toMatchObject({ kind: 'open-session', activate: false })
    h.index.claimOpen('main', { panelId: 'commit', key: 'terminal', title: 'commit', sessionId: 'commit', params: { sessionId: 'commit' } })
    h.acknowledge('main', opening, { kind: 'opened', panelId: 'commit' })
    h.acceptReview(await h.command(1))
    expect((await pending).ok).toBe(true)
    h.acceptReview(await h.command(2))
    h.status('committed')
    h.broker.commitsChanged()
    const command = await h.command(3)
    expect(command).toMatchObject({ kind: 'focus-panel', panelId: 'original' })
    h.acknowledge('main', command, { kind: 'focused', panelId: 'original' })
  })

  it('returns to the original panel in its current window after it was moved', async () => {
    const h = new TabControlHarness()
    h.session('commit')
    h.session('original')
    h.status('editing')
    await h.openReview()
    h.index.release('original', 'main')
    h.session('original', 'holder')
    h.status('committed')
    h.broker.commitsChanged()
    const command = await h.command(2)
    expect(h.windows.published[2]?.windowId).toBe('holder')
    expect(command).toMatchObject({ kind: 'focus-panel', panelId: 'original' })
    h.acknowledge('holder', command, { kind: 'focused', panelId: 'original' })
  })

  it("opens an agent's session tab behind the active one and brings it forward through the queue", async () => {
    const h = new TabControlHarness()
    h.session('original')
    const opened = h.broker.open('agent-session', 'Agent', 'agent')
    const command = await h.command()
    expect(command).toMatchObject({ kind: 'open-session', sessionId: 'agent-session', activate: false })
    h.index.claimOpen('main', { panelId: 'agent-panel', key: 'terminal', title: 'Agent', sessionId: 'agent-session', params: { sessionId: 'agent-session' } })
    h.acknowledge('main', command, { kind: 'opened', panelId: 'agent-panel' })
    expect(await opened).toMatchObject({ ok: true })
    const shown = await h.command(1)
    expect(shown).toMatchObject({ kind: 'focus-panel', panelId: 'agent-panel' })
    h.acknowledge('main', shown, { kind: 'focused', panelId: 'agent-panel' })
    expect(h.windows.focused).toEqual(['main'])
    await h.settled()
    expect(h.attention.snapshot().items).toEqual([])
  })

  it("keeps an agent's session tab waiting while the person types, and opens a person's tab at once", async () => {
    const h = new TabControlHarness()
    h.idleMilliseconds = 20_000
    h.session('original')
    h.attention.personActive()
    const agent = h.broker.open('agent-session', 'Agent', 'agent')
    const command = await h.command()
    h.index.claimOpen('main', { panelId: 'agent-panel', key: 'terminal', title: 'Agent', sessionId: 'agent-session', params: { sessionId: 'agent-session' } })
    h.acknowledge('main', command, { kind: 'opened', panelId: 'agent-panel' })
    expect(await agent).toMatchObject({ ok: true })
    await h.settled()
    expect(h.windows.published).toHaveLength(1)
    expect(h.attention.snapshot().items).toMatchObject([{ kind: 'session-opened', sessionId: 'agent-session', title: 'Agent', automatic: true }])

    const person = h.broker.open('person-session', 'Person', 'person')
    const open = await h.command(1)
    expect(open).toEqual({ kind: 'open-session', requestId: 'request-2', sessionId: 'person-session', tabTitle: 'Person' })
    h.acknowledge('main', open, { kind: 'opened', panelId: 'person-panel' })
    expect(await person).toMatchObject({ ok: true })
    h.stop()
  })

  it('opens in the existing holder without activating a window when the setting is disabled', async () => {
    const h = new TabControlHarness(1_000, false)
    h.index.claimOpen('holder', { panelId: 'panel', key: 'terminal', title: 'App', sessionId: 'session', params: { sessionId: 'session' } })
    const pending = h.broker.openCommit('session', 'App', 'svn', null, null, {})
    const command = await h.command()
    expect(command).toMatchObject({ kind: 'open-commit', activate: false, panelId: 'panel' })
    h.acknowledge('holder', command, { kind: 'commit-opened', panelId: 'panel' })
    expect(await pending).toMatchObject({ ok: true, value: { commitSessionId: 'draft' } })
    expect(h.windows.focused).toEqual([])
  })

  it('requests an inactive new session tab before opening a background commit', async () => {
    const h = new TabControlHarness(1_000, false)
    const pending = h.broker.openCommit('session', 'App', 'git', null, null, {})
    const session = await h.command()
    expect(session).toMatchObject({ kind: 'open-session', activate: false })
    h.acknowledge('main', session, { kind: 'opened', panelId: 'panel' })
    const commit = await h.command(1)
    expect(commit).toMatchObject({ kind: 'open-commit', activate: false })
    h.acknowledge('main', commit, { kind: 'commit-opened', panelId: 'panel' })
    expect((await pending).ok).toBe(true)
    expect(h.windows.focused).toEqual([])
  })
  afterEach(() => vi.useRealTimers())

  it('opens a prepared commit in the existing owner window and reports an unapplied proposal', async () => {
    const harness = new TabControlHarness()
    const pending = harness.broker.openCommit('session-1', 'App', 'svn', 'shared', 'Proposal', {})
    const first = await harness.command()
    harness.acknowledge('main', first, { kind: 'focused-existing', panelId: 'session-panel', windowId: 'holder' })
    const second = await harness.command(1)
    expect(second).toMatchObject({ kind: 'open-commit', scopeRoot: 'Q:/app/shared', messageApplied: false })
    harness.acknowledge('holder', second, { kind: 'commit-opened', panelId: 'session-panel' })
    expect(await pending).toMatchObject({ ok: true, value: { kind: 'commit-opened', scopeRoot: 'Q:/app/shared', windowId: 'holder', messageApplied: false } })
    expect(harness.commits.attach).toHaveBeenCalledWith('draft', 'holder')
    expect(harness.commits.prepare).toHaveBeenCalledWith('session-1', 'svn', 'shared', 'Proposal', undefined, {})
  })

  it('asks for a fresh draft for a caller that waits for the outcome of its review', async () => {
    const harness = new TabControlHarness()
    const pending = harness.broker.openCommit('session-1', 'App', 'svn', 'shared', 'Proposal', { fresh: true })
    const first = await harness.command()
    harness.acknowledge('main', first, { kind: 'focused-existing', panelId: 'session-panel', windowId: 'holder' })
    harness.acknowledge('holder', await harness.command(1), { kind: 'commit-opened', panelId: 'session-panel' })
    expect(await pending).toMatchObject({ ok: true })
    expect(harness.commits.prepare).toHaveBeenCalledWith('session-1', 'svn', 'shared', 'Proposal', undefined, { fresh: true })
  })

  it('does not open a tab after prepare refuses, but a person can see the missing-working-copy pane', async () => {
    const harness = new TabControlHarness()
    harness.commits.prepare.mockResolvedValue({ ok: false, code: 'no-working-copy', detail: 'No SVN here' })
    expect(await harness.broker.openCommit('session-1', 'App', 'svn', null, null, {})).toMatchObject({ ok: false, error: { code: 'operation-failed' } })
    expect(harness.windows.published).toEqual([])
    const pending = harness.broker.openCommit('session-1', 'App', 'svn', null, null, { showRefusal: true })
    harness.acknowledge('main', await harness.command(), { kind: 'opened', panelId: 'panel' })
    harness.acknowledge('main', await harness.command(1), { kind: 'commit-opened', panelId: 'panel' })
    expect(await pending).toMatchObject({ ok: true, value: { kind: 'commit-opened' } })
  })

  it('releases an unattached draft after a tab failure or a renderer timeout', async () => {
    const harness = new TabControlHarness(50)
    const pending = harness.broker.openCommit('session-1', 'App', 'svn', null, null, {})
    harness.acknowledge('main', await harness.command(), { kind: 'failed', detail: 'File cap' })
    expect(await pending).toMatchObject({ ok: false, error: { code: 'operation-failed' } })
    expect(harness.commits.releaseUnattached).toHaveBeenCalledWith('draft')
    const timed = harness.broker.openCommit('session-1', 'App', 'svn', null, null, {})
    expect(await timed).toMatchObject({ ok: false, error: { code: 'timeout' } })
    expect(harness.commits.releaseUnattached).toHaveBeenCalledTimes(2)
    expect(harness.commits.attach).not.toHaveBeenCalled()
  })

  it('lists the full panel snapshot and requests a terminal open from the main renderer', async () => {
    const harness = new TabControlHarness()
    harness.index.claimOpen('holder', {
      panelId: 'probe:1',
      key: 'probe',
      title: 'Probe',
      params: { serial: 1 },
      sessionId: null,
    })
    harness.index.setActivePanel('holder', 'probe:1')

    expect(await harness.broker.list()).toEqual([{
      panelId: 'probe:1',
      windowId: 'holder',
      key: 'probe',
      title: 'Probe',
      params: { serial: 1 },
      sessionId: null,
      active: true,
    }])

    const resultPromise = harness.broker.openTab('session-1', 'Project - 001')
    const command = await harness.command()
    expect(command).toEqual({
      kind: 'open-session',
      requestId: 'request-1',
      sessionId: 'session-1',
      tabTitle: 'Project - 001',
    })
    harness.acknowledge('main', command, {
      kind: 'opened',
      panelId: 'terminal:{"sessionId":"session-1"}',
    })
    await expect(resultPromise).resolves.toEqual({
      ok: true,
      value: {
        kind: 'opened',
        panelId: 'terminal:{"sessionId":"session-1"}',
        windowId: 'main',
      },
    })
    expect(harness.windows.focused).toEqual(['main'])
  })

  it('focuses and closes a tab through its owning renderer', async () => {
    const harness = new TabControlHarness()
    harness.index.claimOpen('holder', {
      panelId: 'terminal:session-1',
      key: 'terminal',
      title: 'Project - 001',
      params: { sessionId: 'session-1' },
      sessionId: 'session-1',
    })

    const focusPromise = harness.broker.focus('terminal:session-1')
    const focusCommand = await harness.command(0)
    harness.acknowledge('holder', focusCommand, {
      kind: 'focused',
      panelId: 'terminal:session-1',
    })
    await expect(focusPromise).resolves.toEqual({
      ok: true,
      value: {
        kind: 'focused-existing',
        panelId: 'terminal:session-1',
        windowId: 'holder',
      },
    })

    const closePromise = harness.broker.close('terminal:session-1')
    const closeCommand = await harness.command(1)
    harness.acknowledge('holder', closeCommand, {
      kind: 'closed',
      panelId: 'terminal:session-1',
    })
    await expect(closePromise).resolves.toEqual({
      ok: true,
      value: {
        kind: 'closed',
        panelId: 'terminal:session-1',
        windowId: 'holder',
      },
    })
    expect(harness.windows.focused).toEqual(['holder'])
  })

  it('reports unknown panels and renderer timeouts without guessing success', async () => {
    vi.useFakeTimers()
    const harness = new TabControlHarness(50)

    await expect(harness.broker.focus('missing')).resolves.toEqual({
      ok: false,
      error: { code: 'not-found', detail: 'No tab "missing"' },
    })
    const openPromise = harness.broker.openTab('session-1', 'Project - 001')
    await vi.advanceTimersByTimeAsync(50)
    await expect(openPromise).resolves.toEqual({
      ok: false,
      error: {
        code: 'timeout',
        detail: 'The workspace renderer did not confirm the tab command',
      },
    })
  })

  it('ends an in-flight command on renderer reload and accepts a command in the next generation', async () => {
    let release!: () => void
    const harness = new TabControlHarness()
    harness.windows.blocked.set('main', new Promise<void>((resolve) => {
      release = resolve
    }))
    const first = harness.broker.openTab('session-1', 'Project - 001')

    harness.broker.rendererGone('main')
    await expect(first).resolves.toEqual({
      ok: false,
      error: { code: 'unavailable', detail: 'The workspace renderer was reloaded' },
    })
    release()
    harness.windows.blocked.delete('main')
    await Promise.resolve()
    expect(harness.windows.published).toEqual([])

    const second = harness.broker.openTab('session-1', 'Project - 001')
    const command = await harness.command()
    harness.acknowledge('main', command, {
      kind: 'opened',
      panelId: 'terminal:{"sessionId":"session-1"}',
    })
    await expect(second).resolves.toMatchObject({ ok: true })
  })

  /*
   * The window is CLOSING: it stopped accepting while the command waited for its renderer, and
   * `rendererGone` has not arrived - unlike `TabTransferBroker` this one has no `cancelClosingWindow`
   * to end it early. Without the second look after the await, the command would be published into a
   * window on its way out and the caller would wait for an acknowledgement nobody can send.
   */
  it('refuses a command whose window stopped accepting while it waited', async () => {
    let release!: () => void
    const harness = new TabControlHarness()
    harness.windows.blocked.set('main', new Promise<void>((resolve) => {
      release = resolve
    }))
    const opened = harness.broker.openTab('session-1', 'Project - 001')

    harness.windows.accepted.delete('main')
    release()

    await expect(opened).resolves.toEqual({
      ok: false,
      error: { code: 'unavailable', detail: 'The workspace renderer is unavailable' },
    })
    expect(harness.windows.published).toEqual([])
  })

  /*
   * A request id belongs to the window it was sent to. A second window answering it would settle
   * somebody else's command with a panel id from its own document, and the tab the caller asked
   * about would be the one nobody looked at.
   */
  it('refuses an acknowledgement from a window the command was not sent to', async () => {
    const harness = new TabControlHarness()
    const opened = harness.broker.openTab('session-1', 'Project - 001')
    const command = await harness.command()

    expect(() => harness.acknowledge('holder', command, {
      kind: 'opened',
      panelId: 'terminal:{"sessionId":"session-1"}',
    })).toThrow(/wrong window/)

    // Still open, and still the owner's to answer.
    harness.acknowledge('main', command, {
      kind: 'opened',
      panelId: 'terminal:{"sessionId":"session-1"}',
    })
    await expect(opened).resolves.toMatchObject({ ok: true })
  })

  it('accepts the existing owner response without adding a duplicate session panel', async () => {
    const harness = new TabControlHarness()
    harness.index.claimOpen('holder', {
      panelId: 'terminal:existing',
      key: 'terminal',
      title: 'Project - 001',
      params: { sessionId: 'session-1' },
      sessionId: 'session-1',
    })
    const opened = harness.broker.openTab('session-1', 'Project - 001')
    const command = await harness.command()
    harness.acknowledge('main', command, {
      kind: 'focused-existing',
      panelId: 'terminal:existing',
      windowId: 'holder',
    })

    await expect(opened).resolves.toEqual({
      ok: true,
      value: {
        kind: 'focused-existing',
        panelId: 'terminal:existing',
        windowId: 'holder',
      },
    })
    expect(harness.index.panelsOfSession('session-1')).toHaveLength(1)
  })

  it.each([false, true])('uses document activation %s independently of commits', async (activate) => {
    const harness = new TabControlHarness(1_000, !activate)
    harness.activateDocuments = activate
    const opened = harness.broker.openFile(
      'session-1',
      'Project - 001',
      'reports/report.md',
    )

    const sessionCommand = await harness.command(0)
    expect(sessionCommand).toEqual({
      kind: 'open-session',
      requestId: 'request-1',
      sessionId: 'session-1',
      tabTitle: 'Project - 001',
      activate,
    })
    harness.acknowledge('main', sessionCommand, {
      kind: 'focused-existing',
      panelId: 'terminal:session-1',
      windowId: 'holder',
    })
    const fileCommand = await harness.command(1)
    expect(harness.windows.published.map((entry) => entry.windowId)).toEqual(['main', 'holder'])
    expect(harness.windows.focused).toEqual(activate ? ['main'] : [])
    expect(fileCommand).toEqual({
      kind: 'open-file',
      requestId: 'request-2',
      panelId: 'terminal:session-1',
      source: {
        kind: 'workspace',
        sessionId: 'session-1',
        path: 'Q:\\Apps\\Project\\reports\\report.md',
      },
      documentKey: 'document-report',
      title: 'report.md',
    })
    harness.acknowledge('holder', fileCommand, {
      kind: 'file-opened',
      panelId: 'terminal:session-1',
    })

    await expect(opened).resolves.toEqual({
      ok: true,
      value: {
        kind: 'file-opened',
        panelId: 'terminal:session-1',
        windowId: 'holder',
        path: 'Q:\\Apps\\Project\\reports\\report.md',
      },
    })
    expect(harness.resolver.calls).toEqual([{
      sessionId: 'session-1',
      path: 'reports/report.md',
    }])
  })

  it('does not send open-file after the session tab open fails', async () => {
    const harness = new TabControlHarness()
    const opened = harness.broker.openFile(
      'session-1',
      'Project - 001',
      'reports/report.md',
    )
    const sessionCommand = await harness.command()
    harness.acknowledge('main', sessionCommand, {
      kind: 'failed',
      detail: 'The terminal could not be opened',
    })

    await expect(opened).resolves.toEqual({
      ok: false,
      error: { code: 'operation-failed', detail: 'The terminal could not be opened' },
    })
    expect(harness.windows.published).toHaveLength(1)
  })

  it('times out while the owning renderer does not confirm open-file', async () => {
    const harness = new TabControlHarness(100)
    const opened = harness.broker.openFile(
      'session-1',
      'Project - 001',
      'reports/report.md',
    )
    const sessionCommand = await harness.command()
    harness.acknowledge('main', sessionCommand, {
      kind: 'opened',
      panelId: 'terminal:session-1',
    })
    await harness.command(1)

    await expect(opened).resolves.toEqual({
      ok: false,
      error: {
        code: 'timeout',
        detail: 'The workspace renderer did not confirm the tab command',
      },
    })
  })

  describe('openTask', () => {
    const itemConst = { key: 'task:session-1:subagent:a1', title: 'Explore: Look at docs', sessionId: 'session-1',
      task: { kind: 'subagent' as const, subagentId: 'a1' } }

    it('opens the parent tab before a script output item and leaves the run terminal alone', async () => {
      const harness = new TabControlHarness()
      const item = { key: 'task:session-1:script:run-1', title: 'Setup project', sessionId: 'session-1',
        task: { kind: 'script' as const, runId: 'run-1' } }
      const opened = harness.broker.openTask('Project - 001', item)
      const sessionCommand = await harness.command(0)
      expect(sessionCommand).toMatchObject({ kind: 'open-session', sessionId: 'session-1', activate: true })
      harness.acknowledge('main', sessionCommand, { kind: 'opened', panelId: 'terminal:session-1' })
      const taskCommand = await harness.command(1)
      expect(taskCommand).toMatchObject({ kind: 'open-task', panelId: 'terminal:session-1', item })
      harness.acknowledge('main', taskCommand, { kind: 'task-opened', panelId: 'terminal:session-1' })
      await expect(opened).resolves.toEqual({ ok: true,
        value: { kind: 'task-opened', panelId: 'terminal:session-1', windowId: 'main' } })
      expect(harness.windows.published).toHaveLength(2)
    })

    it("sends open-task to the window that holds the parent's tab and focuses that window", async () => {
      const harness = new TabControlHarness()
      harness.session('session-1', 'holder')
      harness.windows.focusOrRecreate('main')
      const opened = harness.broker.openTask('Project - 001', itemConst)

      const command = await harness.command()
      expect(harness.windows.published.map((entry) => entry.windowId)).toEqual(['holder'])
      expect(harness.windows.focused).toEqual(['main', 'holder'])
      expect(command).toEqual({ kind: 'open-task', requestId: 'request-1', panelId: 'session-1', item: itemConst })
      harness.acknowledge('holder', command, { kind: 'task-opened', panelId: 'session-1' })

      await expect(opened).resolves.toEqual({ ok: true, value: { kind: 'task-opened', panelId: 'session-1', windowId: 'holder' } })
    })

    it('opens the tab first for a session with no tab, then sends open-task where it landed', async () => {
      const harness = new TabControlHarness()
      const opened = harness.broker.openTask('Project - 001', itemConst)

      const sessionCommand = await harness.command(0)
      expect(sessionCommand).toEqual({ kind: 'open-session', requestId: 'request-1', sessionId: 'session-1',
        tabTitle: 'Project - 001', activate: true })
      harness.acknowledge('main', sessionCommand, { kind: 'opened', panelId: 'terminal:session-1' })
      const taskCommand = await harness.command(1)
      expect(taskCommand).toEqual({ kind: 'open-task', requestId: 'request-2', panelId: 'terminal:session-1', item: itemConst })
      expect(harness.windows.published.map((entry) => entry.windowId)).toEqual(['main', 'main'])
      harness.acknowledge('main', taskCommand, { kind: 'task-opened', panelId: 'terminal:session-1' })

      await expect(opened).resolves.toEqual({ ok: true,
        value: { kind: 'task-opened', panelId: 'terminal:session-1', windowId: 'main' } })
    })

    it("passes on the window's refusal of a ninth task view", async () => {
      const harness = new TabControlHarness()
      harness.session('session-1')
      const opened = harness.broker.openTask('Project - 001', itemConst)
      harness.acknowledge('main', await harness.command(), { kind: 'failed', detail: 'The split already holds 8 task views.' })

      await expect(opened).resolves.toEqual({ ok: false,
        error: { code: 'operation-failed', detail: 'The split already holds 8 task views.' } })
    })
  })
  describe('openSessionActions', () => {
    it('forwards a source task to its target owner without matching a local session with the same ID', async () => {
      const harness = new TabControlHarness()
      harness.session('session', 'main')
      const target = { kind: 'remote', remoteEndpointId: 'peer', sessionId: 'session' } as const
      const task = { kind: 'script', runId: 'run' } as const
      harness.index.claimOpen('holder', { panelId: 'remote', key: 'terminal', title: 'Remote', sessionId: null, params: { target } })
      const pending = harness.broker.openSessionTask(target, task, 'Script')
      const command = await harness.command()
      expect(command).toMatchObject({ kind: 'open-task', panelId: 'remote', target, item: { sessionId: 'session', task } })
      expect(harness.windows.published.map((entry) => entry.windowId)).toEqual(['holder'])
      harness.acknowledge('holder', command, { kind: 'task-opened', panelId: 'remote' })
      expect(await pending).toMatchObject({ ok: true, value: { windowId: 'holder' } })
      expect(await harness.broker.openSessionTask({ ...target, remoteEndpointId: 'foreign' }, task, 'Script'))
        .toMatchObject({ ok: false, error: { code: 'not-found' } })
      expect(harness.windows.published).toHaveLength(1)
    })
    it('routes an endpoint-qualified remote session to its owning window and refuses missing targets', async () => {
      const harness = new TabControlHarness()
      harness.session('session', 'main')
      const target = { kind: 'remote', remoteEndpointId: 'peer', sessionId: 'session' } as const
      harness.index.claimOpen('holder', { panelId: 'remote', key: 'terminal', title: 'Remote', sessionId: null, params: { target } })
      const pending = harness.broker.openSessionActions(target)
      const command = await harness.command()
      expect(harness.windows.published.map((entry) => entry.windowId)).toEqual(['holder'])
      expect(command).toMatchObject({ kind: 'open-workflow', panelId: 'remote', target })
      harness.acknowledge('holder', command, { kind: 'workflow-opened', panelId: 'remote' })
      expect(await pending).toMatchObject({ ok: true, value: { windowId: 'holder' } })
      expect(await harness.broker.openSessionActions({ ...target, remoteEndpointId: 'foreign' }))
        .toMatchObject({ ok: false, error: { code: 'not-found' } })
      expect(harness.windows.published).toHaveLength(1)
    })
  })

  describe('openWorkflow', () => {
    it('opens a missing tab first, focuses its window, then sends open-workflow where it landed', async () => {
      const harness = new TabControlHarness()
      const opened = harness.broker.openWorkflow('session-1', 'Project - 001')

      const sessionCommand = await harness.command(0)
      expect(sessionCommand).toEqual({ kind: 'open-session', requestId: 'request-1', sessionId: 'session-1',
        tabTitle: 'Project - 001', activate: true })
      harness.acknowledge('main', sessionCommand, { kind: 'opened', panelId: 'terminal:session-1' })
      const workflowCommand = await harness.command(1)
      expect(workflowCommand).toEqual({ kind: 'open-workflow', requestId: 'request-2', panelId: 'terminal:session-1', sessionId: 'session-1' })
      expect(harness.windows.focused).toContain('main')
      harness.acknowledge('main', workflowCommand, { kind: 'workflow-opened', panelId: 'terminal:session-1' })

      await expect(opened).resolves.toEqual({ ok: true,
        value: { kind: 'workflow-opened', panelId: 'terminal:session-1', windowId: 'main' } })
    })

    it("sends open-workflow to the window that holds the session's tab and focuses that window", async () => {
      const harness = new TabControlHarness()
      harness.session('session-1', 'holder')
      harness.windows.focusOrRecreate('main')
      const opened = harness.broker.openWorkflow('session-1', 'Project - 001')

      const command = await harness.command()
      expect(harness.windows.published.map((entry) => entry.windowId)).toEqual(['holder'])
      expect(harness.windows.focused).toEqual(['main', 'holder'])
      expect(command).toEqual({ kind: 'open-workflow', requestId: 'request-1', panelId: 'session-1', sessionId: 'session-1' })
      harness.acknowledge('holder', command, { kind: 'workflow-opened', panelId: 'session-1' })

      await expect(opened).resolves.toEqual({ ok: true, value: { kind: 'workflow-opened', panelId: 'session-1', windowId: 'holder' } })
    })

    it('reads an acknowledgement of another kind as a failed command', async () => {
      const harness = new TabControlHarness()
      harness.session('session-1')
      const opened = harness.broker.openWorkflow('session-1', 'Project - 001')
      harness.acknowledge('main', await harness.command(), { kind: 'task-opened', panelId: 'session-1' })

      await expect(opened).resolves.toMatchObject({ ok: false, error: { code: 'operation-failed' } })
    })
  })
})


it.each([false, true])('opens a snap-in through its owner, existing: %s', async (existing) => {
  const harness = new TabControlHarness()
  if (existing) harness.index.claimOpen('holder', { panelId: 'snapin:review-todos', key: 'snapin', title: 'Review todos', params: { kind: 'review-todos' }, sessionId: null })
  const opened = harness.broker.openSnapin('review-todos', 'Review todos')
  const command = await harness.command()
  expect(command).toMatchObject({ kind: 'open-snapin', panelId: 'snapin:review-todos', snapinKind: 'review-todos', title: 'Review todos' })
  const windowId = existing ? 'holder' : 'main'
  harness.acknowledge(windowId, command, { kind: 'snapin-opened', panelId: 'snapin:review-todos' })
  expect(await opened).toEqual({ ok: true, value: { kind: 'snapin-opened', panelId: 'snapin:review-todos', windowId } })
  expect(harness.windows.focused).toEqual([windowId])
})

it('records a semantic task once and does not let a failed observer block the local open', async () => {
  const recorded = vi.fn<NonNullable<TabControlBrokerDeps['recordOpen']>>(async (item) => ({ ...item, sequence: 1 }))
  const harness = new TabControlHarness(1000, true, true, 300000, recorded)
  harness.session('parent')
  const item = { sessionId: 'parent', key: 'task:parent:script:run', title: 'Script', task: { kind: 'script' as const, runId: 'run' } }
  const first = harness.broker.openTask('Parent', item)
  const command = await harness.command()
  expect(command.sharedOpen).toMatchObject({ sessionId: 'parent', item: { kind: 'task', task: item.task }, sequence: 1 })
  harness.acknowledge('main', command, { kind: 'task-opened', panelId: 'parent' })
  expect((await first).ok).toBe(true)
  expect(recorded).toHaveBeenCalledOnce()
  recorded.mockRejectedValueOnce(new Error('peer unavailable'))
  const second = harness.broker.openTask('Parent', item)
  const next = await harness.command(1)
  expect(next.sharedOpen).toBeUndefined()
  harness.acknowledge('main', next, { kind: 'task-opened', panelId: 'parent' })
  expect((await second).ok).toBe(true)
})


it('preserves the source control intent ID across real broker retries and gives a new reopen another ID', async () => {
  const recorded = vi.fn<NonNullable<TabControlBrokerDeps['recordOpen']>>(async (item) => ({ ...item, sequence: 1 }))
  const harness = new TabControlHarness(1000, true, true, 300000, recorded)
  harness.session('parent')
  const item = { sessionId: 'parent', key: 'task', title: 'Script', task: { kind: 'script' as const, runId: 'run' } }
  for (const [index, intent] of ['operation-1', 'operation-1', 'operation-2'].entries()) {
    const pending = harness.broker.openTask('Parent', item, intent)
    const command = await harness.command(index)
    harness.acknowledge('main', command, { kind: 'task-opened', panelId: 'parent' })
    expect((await pending).ok).toBe(true)
  }
  expect(recorded.mock.calls[0][0].openId).toBe(recorded.mock.calls[1][0].openId)
  expect(recorded.mock.calls[1][0].openId).not.toBe(recorded.mock.calls[2][0].openId)
})
