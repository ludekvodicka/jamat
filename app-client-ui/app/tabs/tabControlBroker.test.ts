import { afterEach, describe, expect, it, vi } from 'vitest'

import type { TabControlAck, TabControlCommand } from '../../shared/tabControl'
import type { WorkspaceWindows } from '../shell/workspaceWindows'
import type { VersioningCommitManager } from '../versioning/versioningCommitManager'
import { TabControlBroker } from './tabControlBroker'
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
  readonly broker: TabControlBroker
  readonly drafts = new Map<string, NonNullable<ReturnType<VersioningCommitManager['status']>>>()
  private nextRequest = 0

  /** Milliseconds, advanced by a test that wants the broker to see a review it sat in. */
  clock = 0
  activateDocuments = false

  constructor(timeoutMilliseconds = 1_000, activateSessionOnCommit = true, returnToPreviousSessionAfterCommit = true,
    returnWindowMilliseconds: number | null = 300_000) {
    this.broker = new TabControlBroker(
      this.windows.asWindows(),
      this.index,
      this.resolver,
      this.commits,
      {
        requestId: () => `request-${++this.nextRequest}`,
        timeoutMilliseconds,
        activateSessionOnCommit: () => activateSessionOnCommit,
        activateSessionOnDocument: () => this.activateDocuments,
        returnToPreviousSessionAfterCommit: () => returnToPreviousSessionAfterCommit,
        returnWindowMilliseconds: () => returnWindowMilliseconds,
        now: () => this.clock,
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

  async openReview(options: { showRefusal?: true } = {}): Promise<void> {
    const commandIndex = this.windows.published.length
    const pending = this.broker.openCommit('commit', 'Commit', 'svn', null, null, options)
    const command = await this.command(commandIndex)
    const windowId = this.index.ownerOf('commit')!
    if (command.kind === 'open-commit' && command.activate)
      this.index.setActivePanel(windowId, 'commit')
    this.acknowledge(windowId, command, { kind: 'commit-opened', panelId: 'commit' })
    expect((await pending).ok).toBe(true)
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
    this.acceptReview(await this.command(commandIndex))
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
  })

  it('queues reviews across windows in arrival order and returns only after the last one', async () => {
    const h = new TabControlHarness()
    h.session('first')
    h.session('second', 'holder')
    h.session('third')
    h.session('original')
    await h.queueReview('first', 'one')
    await h.queueReview('second', 'two', ['Q:/app/two/a.txt', 'Q:/app/two/b.txt'])
    await h.queueReview('third', 'three')
    expect(h.windows.published.map(({ command }) => command)).toMatchObject([
      { panelId: 'first', activate: true }, { panelId: 'second', activate: false }, { panelId: 'third', activate: false },
    ])
    expect(h.windows.focused).toEqual(['main'])
    expect(h.index.snapshot().find((panel) => panel.panelId === 'first')?.active).toBe(true)

    h.finishReview('one')
    const second = await h.command(3)
    expect(second).toMatchObject({ kind: 'open-commit', panelId: 'second', scopeRoot: 'Q:/app/two', activate: true,
      paths: ['Q:/app/two/a.txt', 'Q:/app/two/b.txt'], messageApplied: false, existingOnly: true })
    h.acceptReview(second)
    h.finishReview('two', 'cancelled', true)
    const third = await h.command(4)
    expect(third).toMatchObject({ kind: 'open-commit', panelId: 'third', activate: true })
    h.acceptReview(third)
    h.finishReview('three')
    const returned = await h.command(5)
    expect(returned).toMatchObject({ kind: 'focus-panel', panelId: 'original' })
    h.acknowledge('main', returned, { kind: 'focused', panelId: 'original' })
    h.broker.commitsChanged()
    await h.settled()
    expect(h.windows.published).toHaveLength(6)
    expect(h.commits.prepare).toHaveBeenCalledTimes(3)
  })

  it('deduplicates reopened waiting reviews without reactivating them', async () => {
    const h = new TabControlHarness()
    h.session('first')
    h.session('second')
    h.session('original')
    await h.queueReview('first', 'one')
    await h.queueReview('second', 'two')
    await h.queueReview('second', 'two')
    await h.queueReview('first', 'one')
    expect(h.windows.focused).toEqual(['main'])
    h.finishReview('one')
    const next = await h.command(4)
    expect(next).toMatchObject({ panelId: 'second', activate: true })
    h.acceptReview(next)
    h.finishReview('two')
    const returned = await h.command(5)
    expect(returned).toMatchObject({ kind: 'focus-panel', panelId: 'original' })
    h.acknowledge('main', returned, { kind: 'focused', panelId: 'original' })
  })

  it.each(['failed', 'running', 'external-closed'] as const)('holds the queue while the current review is %s', async (state) => {
    const h = new TabControlHarness()
    h.session('first')
    h.session('second')
    h.session('original')
    await h.queueReview('first', 'one')
    await h.queueReview('second', 'two')
    h.finishReview('one', state)
    await h.settled()
    expect(h.windows.published).toHaveLength(2)
    h.finishReview('one')
    h.acceptReview(await h.command(2))
    h.broker.cancelAll()
  })

  it.each(['cancelled', 'committed', 'unknown', 'closed-tab'] as const)('skips a waiting review that is already %s', async (state) => {
    const h = new TabControlHarness()
    h.session('first')
    h.session('second')
    h.session('third')
    h.session('original')
    await h.queueReview('first', 'one')
    await h.queueReview('second', 'two')
    await h.queueReview('third', 'three')
    if (state === 'cancelled') h.finishReview('two', 'cancelled', true)
    else if (state === 'committed') h.finishReview('two')
    else if (state === 'unknown') h.drafts.delete('two')
    else if (state === 'closed-tab') h.index.release('second', 'main')
    else throw new Error(`Unknown state: ${state}`)
    h.finishReview('one')
    const next = await h.command(3)
    expect(next).toMatchObject({ panelId: 'third', activate: true })
    h.acceptReview(next)
    h.broker.cancelAll()
  })

  it.each(['disabled', 'expired'] as const)('still advances the queue when the final return is %s', async (mode) => {
    const h = new TabControlHarness(1_000, true, mode !== 'disabled')
    h.session('first')
    h.session('second')
    h.session('original')
    await h.queueReview('first', 'one')
    h.clock = 300_001
    await h.queueReview('second', 'two')
    h.finishReview('one')
    h.acceptReview(await h.command(2))
    h.finishReview('two')
    await h.settled()
    expect(h.windows.published).toHaveLength(3)
  })

  it.each(['other-session', 'other-app'] as const)('stops advancing after the person moves to %s', async (move) => {
    const h = new TabControlHarness()
    h.session('first')
    h.session('second')
    h.session('original')
    await h.queueReview('first', 'one')
    await h.queueReview('second', 'two')
    if (move === 'other-session') h.session('other')
    else if (move === 'other-app') h.windows.focusedWindowId = null
    else throw new Error(`Unknown move: ${move}`)
    h.finishReview('one')
    await h.settled()
    expect(h.windows.published).toHaveLength(2)
    h.finishReview('two')
    await h.settled()
    expect(h.windows.published).toHaveLength(2)
  })

  it('uses the current owner when the next review tab has moved', async () => {
    const h = new TabControlHarness()
    h.session('first')
    h.session('second')
    h.session('original')
    await h.queueReview('first', 'one')
    await h.queueReview('second', 'two')
    h.index.release('second', 'main')
    h.session('second', 'holder')
    h.finishReview('one')
    const next = await h.command(2)
    expect(h.windows.published[2]?.windowId).toBe('holder')
    h.acceptReview(next)
    h.broker.cancelAll()
  })

  it('stops the sequence after an unconfirmed handoff instead of activating another review', async () => {
    const h = new TabControlHarness()
    h.session('first')
    h.session('second')
    h.session('third')
    h.session('original')
    await h.queueReview('first', 'one')
    await h.queueReview('second', 'two')
    await h.queueReview('third', 'three')
    h.finishReview('one')
    const next = await h.command(3)
    h.acknowledge('main', next, { kind: 'failed', detail: 'The renderer cannot activate the review' })
    await h.settled()
    h.finishReview('two')
    await h.settled()
    expect(h.windows.published).toHaveLength(4)
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
    expect(command).toMatchObject({ panelId: 'first', activate: true })
    expect(h.commits.prepare).toHaveBeenCalledTimes(1)
    h.acceptReview(command)
    expect((await first).ok).toBe(true)
    const queued = await h.command(1)
    expect(queued).toMatchObject({ panelId: 'second', activate: false })
    h.acceptReview(queued)
    expect((await second).ok).toBe(true)
    h.broker.cancelAll()
  })

  it('cancels serialized opens when the application is stopping', async () => {
    const h = new TabControlHarness()
    h.session('first')
    h.session('second')
    h.status('editing')
    const first = h.broker.openCommit('first', 'First', 'svn', null, null, {})
    const second = h.broker.openCommit('second', 'Second', 'svn', null, null, {})
    await h.command()
    h.broker.cancelAll()
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
    h.finishReview('one')
    const command = await h.command(1)
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
      const command = await h.command(1)
      expect(command).toMatchObject({ kind: 'focus-panel', panelId: 'original' })
      expect(h.windows.published[1]?.windowId).toBe('main')
      h.acknowledge('main', command, { kind: 'focused', panelId: 'original' })
      h.broker.commitsChanged()
      await Promise.resolve()
      expect(h.windows.published).toHaveLength(2)
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
      await Promise.resolve()
      expect(h.windows.published).toHaveLength(1)
    },
  )

  /**
   * The person who reads the diff, thinks about it and commits ten minutes later is no longer being
   * interrupted by the review: the review is the work, and the tab they left ten minutes ago is the
   * interruption. The window is measured from the open because that is the moment the tab appeared.
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

    await Promise.resolve()
    expect(h.windows.published).toHaveLength(1)
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

      const command = await h.command(1)
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
      await h.openReview(mode === 'manual' ? { showRefusal: true } : {})
      h.index.setActivePanel('main', 'commit')
      h.status('committed')
      h.broker.commitsChanged()
      await Promise.resolve()
      expect(h.windows.published).toHaveLength(1)
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
      await Promise.resolve()
      expect(h.windows.published).toHaveLength(1)
    },
  )

  it('keeps the original return destination when a review is opened again', async () => {
    const h = new TabControlHarness()
    h.session('commit')
    h.session('original')
    h.status('editing')
    await h.openReview()
    await h.openReview()
    h.status('cancelled', true)
    h.broker.commitsChanged()
    const command = await h.command(2)
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
    await h.openReview()
    h.status('committed')
    const completed = h.commits.status('draft')!
    h.commits.status.mockImplementation((id) => ({ ...completed, commitSessionId: id, state: id === 'second' ? 'editing' : 'committed' }))
    h.broker.commitsChanged()
    const next = await h.command(2)
    expect(next).toMatchObject({ kind: 'open-commit', scopeRoot: 'Q:/app/other', activate: true })
    h.acceptReview(next)
    h.status('committed')
    h.broker.commitsChanged()
    const command = await h.command(3)
    expect(command).toMatchObject({ kind: 'focus-panel', panelId: 'original' })
    h.acknowledge('main', command, { kind: 'focused', panelId: 'original' })
  })

  it('captures the last focused workspace before bringing a background app forward', async () => {
    const h = new TabControlHarness()
    h.session('commit')
    h.session('original', 'holder')
    h.windows.lastFocusedWindowId = 'holder'
    h.windows.focusedWindowId = null
    h.status('editing')
    await h.openReview()
    h.status('committed')
    h.broker.commitsChanged()
    const command = await h.command(1)
    expect(command).toMatchObject({ kind: 'focus-panel', panelId: 'original' })
    h.acknowledge('holder', command, { kind: 'focused', panelId: 'original' })
  })

  it('captures the origin before creating and activating a new commit session tab', async () => {
    const h = new TabControlHarness()
    h.session('original')
    h.status('editing')
    const pending = h.broker.openCommit('commit', 'Commit', 'git', null, null, {})
    const opening = await h.command()
    expect(opening).toMatchObject({ kind: 'open-session', activate: true })
    h.session('commit')
    h.acknowledge('main', opening, { kind: 'opened', panelId: 'commit' })
    h.acknowledge('main', await h.command(1), { kind: 'commit-opened', panelId: 'commit' })
    expect((await pending).ok).toBe(true)
    h.status('committed')
    h.broker.commitsChanged()
    const command = await h.command(2)
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
    const command = await h.command(1)
    expect(h.windows.published[1]?.windowId).toBe('holder')
    expect(command).toMatchObject({ kind: 'focus-panel', panelId: 'original' })
    h.acknowledge('holder', command, { kind: 'focused', panelId: 'original' })
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
    expect(harness.commits.prepare).toHaveBeenCalledWith('session-1', 'svn', 'shared', 'Proposal', undefined)
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

    const resultPromise = harness.broker.open('session-1', 'Project - 001', {})
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
    const openPromise = harness.broker.open('session-1', 'Project - 001', {})
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
    const first = harness.broker.open('session-1', 'Project - 001', {})

    harness.broker.rendererGone('main')
    await expect(first).resolves.toEqual({
      ok: false,
      error: { code: 'unavailable', detail: 'The workspace renderer was reloaded' },
    })
    release()
    harness.windows.blocked.delete('main')
    await Promise.resolve()
    expect(harness.windows.published).toEqual([])

    const second = harness.broker.open('session-1', 'Project - 001', {})
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
    const opened = harness.broker.open('session-1', 'Project - 001', {})

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
    const opened = harness.broker.open('session-1', 'Project - 001', {})
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
    const opened = harness.broker.open('session-1', 'Project - 001', {})
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
})
