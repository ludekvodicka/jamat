import { afterEach, describe, expect, it, vi } from 'vitest'

import type { TabControlAck, TabControlCommand } from '../../shared/tabControl'
import type { WorkspaceWindows } from '../shell/workspaceWindows'
import { TabControlBroker } from './tabControlBroker'
import type { TabFileOpenResolution } from './tabFileOpenResolver'
import { WorkspacePanelIndex } from './workspacePanelIndex'

class FakeWindows {
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
    attach: vi.fn(), releaseUnattached: vi.fn(), status: vi.fn(() => null),
  }
  readonly broker: TabControlBroker
  private nextRequest = 0

  constructor(timeoutMilliseconds = 1_000, activateSessionOnCommit = true) {
    this.broker = new TabControlBroker(
      this.windows.asWindows(),
      this.index,
      this.resolver,
      this.commits,
      {
        requestId: () => `request-${++this.nextRequest}`,
        timeoutMilliseconds,
        activateSessionOnCommit: () => activateSessionOnCommit,
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
  it('opens in the existing holder without activating a window when the setting is disabled', async () => {
    const h = new TabControlHarness(1_000, false)
    h.index.claimOpen('holder', { panelId: 'panel', key: 'terminal', title: 'App', sessionId: 'session', params: { sessionId: 'session' }, presentation: 'session' })
    const pending = h.broker.openCommit('session', 'App', 'svn', null, null, { plain: false })
    const command = await h.command()
    expect(command).toMatchObject({ kind: 'open-commit', activate: false, panelId: 'panel' })
    h.acknowledge('holder', command, { kind: 'commit-opened', panelId: 'panel' })
    expect(await pending).toMatchObject({ ok: true, value: { commitSessionId: 'draft' } })
    expect(h.windows.focused).toEqual([])
  })

  it('requests an inactive new session tab before opening a background commit', async () => {
    const h = new TabControlHarness(1_000, false)
    const pending = h.broker.openCommit('session', 'App', 'git', null, null, { plain: false })
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
    const pending = harness.broker.openCommit('session-1', 'App', 'svn', 'shared', 'Proposal', { plain: false })
    const first = await harness.command()
    harness.acknowledge('main', first, { kind: 'focused-existing', panelId: 'session-panel', windowId: 'holder' })
    const second = await harness.command(1)
    expect(second).toMatchObject({ kind: 'open-commit', scopeRoot: 'Q:/app/shared', messageApplied: false })
    harness.acknowledge('holder', second, { kind: 'commit-opened', panelId: 'session-panel' })
    expect(await pending).toMatchObject({ ok: true, value: { kind: 'commit-opened', scopeRoot: 'Q:/app/shared', windowId: 'holder', messageApplied: false } })
    expect(harness.commits.attach).toHaveBeenCalledWith('draft', 'holder')
    expect(harness.commits.prepare).toHaveBeenCalledWith('session-1', 'svn', 'shared', 'Proposal')
  })

  it('does not open a tab after prepare refuses, but a person can see the missing-working-copy pane', async () => {
    const harness = new TabControlHarness()
    harness.commits.prepare.mockResolvedValue({ ok: false, code: 'no-working-copy', detail: 'No SVN here' })
    expect(await harness.broker.openCommit('session-1', 'App', 'svn', null, null, { plain: false })).toMatchObject({ ok: false, error: { code: 'operation-failed' } })
    expect(harness.windows.published).toEqual([])
    const pending = harness.broker.openCommit('session-1', 'App', 'svn', null, null, { plain: false, showRefusal: true })
    harness.acknowledge('main', await harness.command(), { kind: 'opened', panelId: 'panel' })
    harness.acknowledge('main', await harness.command(1), { kind: 'commit-opened', panelId: 'panel' })
    expect(await pending).toMatchObject({ ok: true, value: { kind: 'commit-opened' } })
  })

  it('releases an unattached draft after a tab failure or a renderer timeout', async () => {
    const harness = new TabControlHarness(50)
    const pending = harness.broker.openCommit('session-1', 'App', 'svn', null, null, { plain: true })
    harness.acknowledge('main', await harness.command(), { kind: 'failed', detail: 'File cap' })
    expect(await pending).toMatchObject({ ok: false, error: { code: 'operation-failed' } })
    expect(harness.commits.releaseUnattached).toHaveBeenCalledWith('draft')
    const timed = harness.broker.openCommit('session-1', 'App', 'svn', null, null, { plain: true })
    expect(await timed).toMatchObject({ ok: false, error: { code: 'timeout' } })
    expect(harness.commits.releaseUnattached).toHaveBeenCalledTimes(2)
    expect(harness.commits.attach).not.toHaveBeenCalled()
  })

  it('lists the full panel snapshot and requests a plain terminal open from the main renderer', async () => {
    const harness = new TabControlHarness()
    harness.index.claimOpen('holder', {
      panelId: 'probe:1',
      key: 'probe',
      title: 'Probe',
      params: { serial: 1 },
      sessionId: null,
      presentation: null,
    })
    harness.index.setActivePanel('holder', 'probe:1')

    expect(await harness.broker.list()).toEqual([{
      panelId: 'probe:1',
      windowId: 'holder',
      key: 'probe',
      title: 'Probe',
      params: { serial: 1 },
      sessionId: null,
      presentation: null,
      active: true,
    }])

    const resultPromise = harness.broker.open('session-1', 'Project - 001', { plain: true })
    const command = await harness.command()
    expect(command).toEqual({
      kind: 'open-session',
      requestId: 'request-1',
      sessionId: 'session-1',
      tabTitle: 'Project - 001',
      plain: true,
    })
    harness.acknowledge('main', command, {
      kind: 'opened',
      panelId: 'terminal:{"sessionId":"session-1","presentation":"tab"}',
    })
    await expect(resultPromise).resolves.toEqual({
      ok: true,
      value: {
        kind: 'opened',
        panelId: 'terminal:{"sessionId":"session-1","presentation":"tab"}',
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
      presentation: 'session',
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
    const openPromise = harness.broker.open('session-1', 'Project - 001', { plain: false })
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
    const first = harness.broker.open('session-1', 'Project - 001', { plain: false })

    harness.broker.rendererGone('main')
    await expect(first).resolves.toEqual({
      ok: false,
      error: { code: 'unavailable', detail: 'The workspace renderer was reloaded' },
    })
    release()
    harness.windows.blocked.delete('main')
    await Promise.resolve()
    expect(harness.windows.published).toEqual([])

    const second = harness.broker.open('session-1', 'Project - 001', { plain: false })
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
    const opened = harness.broker.open('session-1', 'Project - 001', { plain: false })

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
    const opened = harness.broker.open('session-1', 'Project - 001', { plain: false })
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
      presentation: 'session',
    })
    const opened = harness.broker.open('session-1', 'Project - 001', { plain: false })
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

  it('preserves a plain session and applies the file in the window that owns its tab', async () => {
    const harness = new TabControlHarness()
    const opened = harness.broker.openFile(
      'session-1',
      'Project - 001',
      'reports/report.md',
      { plain: true },
    )

    const sessionCommand = await harness.command(0)
    expect(sessionCommand).toEqual({
      kind: 'open-session',
      requestId: 'request-1',
      sessionId: 'session-1',
      tabTitle: 'Project - 001',
      plain: true,
    })
    harness.acknowledge('main', sessionCommand, {
      kind: 'focused-existing',
      panelId: 'terminal:session-1',
      windowId: 'holder',
    })
    const fileCommand = await harness.command(1)
    expect(harness.windows.published.map((entry) => entry.windowId)).toEqual(['main', 'holder'])
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
      { plain: false },
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
      { plain: false },
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
