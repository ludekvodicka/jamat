import { afterEach, describe, expect, it, vi } from 'vitest'

import type { TabControlCommand } from '../../shared/tabControl'
import { PanelKeysConst } from '../../shared/tabTransfer'
import { PanelSplitParams } from '../widgets/tabs/panelSplit'
import type { TabsController } from '../widgets/tabs/tabsController'
import { WorkspacePanels } from './workspacePanels'

class WorkspacePanelsTestController {
  readonly panelId = 'terminal:{"sessionId":"session-one"}'
  key: string | null = PanelKeysConst.terminal
  params: Record<string, unknown> = { sessionId: 'session-one' }
  writes = 0
  readonly hidden: string[] = []
  readonly activated: string[] = []
  readonly focused: string[] = []
  activatePanel(id: string): boolean { this.activated.push(id); return true }
  focusPanelContent(id: string): void { this.focused.push(id) }

  activePanelId(): string | null {
    return this.key === null ? null : this.panelId
  }

  keyOf(panelId: string): string | null {
    return panelId === this.panelId ? this.key : null
  }

  transferPayload(): { params: Record<string, unknown> } {
    return { params: this.params }
  }

  applyPanelParameters(
    panelId: string,
    merge: (params: Record<string, unknown>) => Record<string, unknown>,
  ): boolean {
    if (panelId !== this.panelId)
      return false
    const current = { ...this.params }
    const next = merge(current)
    if (next !== current) {
      this.params = next
      this.writes += 1
    }
    return true
  }

  async hidePanel(panelId: string): Promise<void> {
    if (panelId !== this.panelId)
      return
    this.hidden.push(panelId)
    this.key = null
  }

  asController(): TabsController {
    return this as unknown as TabsController
  }
}

describe('app-client-ui/renderer/shell/workspacePanels', () => {
  it.each([false, true])('opens or focuses the fixed snap-in panel, existing: %s', async (existing) => {
    const openPanel = vi.fn(async () => ({ kind: 'opened', panelId: 'snapin:review-todos' }))
    const activatePanel = vi.fn()
    const controller = { keyOf: () => existing ? PanelKeysConst.snapin : null, openPanel, activatePanel } as unknown as TabsController
    expect(await WorkspacePanels.tabControlResult(controller, { kind: 'open-snapin', requestId: 'r', panelId: 'snapin:review-todos', snapinKind: 'review-todos', title: 'Review todos' }))
      .toEqual({ kind: 'snapin-opened', panelId: 'snapin:review-todos' })
    if (existing) { expect(activatePanel).toHaveBeenCalledWith('snapin:review-todos'); expect(openPanel).not.toHaveBeenCalled() }
    else expect(openPanel).toHaveBeenCalledWith(PanelKeysConst.snapin, 'Review todos', { kind: 'review-todos' }, 'snapin:review-todos')
  })

  it('throws for an unknown tab control command', async () => {
    await expect(WorkspacePanels.tabControlResult({} as TabsController, { kind: 'future' } as unknown as TabControlCommand)).rejects.toThrow('Unknown tab control command')
  })
  it('collects every open terminal task item, including inactive items, but excludes file history and other panels', () => {
    const task = (sessionId: string, runId: string) => ({ kind: 'task' as const,
      key: `task:${sessionId}:script:${runId}`, title: runId, sessionId, task: { kind: 'script' as const, runId } })
    const active = task('one', 'active')
    const inactive = task('one', 'inactive')
    const background = task('two', 'background')
    const history = task('one', 'history')
    const params = (items: ReturnType<typeof task>[]) => ({ split: {
      ...PanelSplitParams.default(), items, active: items[0]?.key ?? null, history: [history],
    } })
    const controller = { openPanels: () => [
      { key: PanelKeysConst.terminal, params: params([active, inactive]) },
      { key: PanelKeysConst.terminal, params: params([background]) },
      { key: PanelKeysConst.fileViewer, params: params([task('other', 'unrelated')]) },
    ] } as unknown as TabsController
    expect([...WorkspacePanels.openTaskKeys(controller)]).toEqual([active.key, inactive.key, background.key])
  })

  it('offers Escape only for a full file viewer or the active file or task view in a terminal split', () => {
    const controller = new WorkspacePanelsTestController()
    const file = WorkspacePanelsTest.item('one')
    const commit = { kind: 'commit' as const, key: 'commit', title: 'Commit', vcs: 'svn' as const, scopeRoot: 'Q:/app' }
    const shell = { kind: 'task' as const, key: 'task:session-one:shell:b1', title: '$ ping', sessionId: 'session-one',
      task: { kind: 'shell' as const, shellId: 'b1' } }
    controller.params = PanelSplitParams.merged(controller.params, {
      ...PanelSplitParams.default(), items: [file, commit, shell], active: file.key,
    })
    expect(WorkspacePanels.hasActiveViewer(controller.asController())).toBe(true)
    controller.params = PanelSplitParams.merged(controller.params, {
      ...PanelSplitParams.of(controller.params), active: shell.key,
    })
    expect(WorkspacePanels.hasActiveViewer(controller.asController())).toBe(true)
    controller.params = PanelSplitParams.merged(controller.params, {
      ...PanelSplitParams.of(controller.params), active: commit.key,
    })
    expect(WorkspacePanels.hasActiveViewer(controller.asController())).toBe(false)
    controller.params = {}
    expect(WorkspacePanels.hasActiveViewer(controller.asController())).toBe(false)
    controller.key = PanelKeysConst.fileViewer
    expect(WorkspacePanels.hasActiveViewer(controller.asController())).toBe(true)
    for (const key of [null, PanelKeysConst.welcome, PanelKeysConst.directoryViewer]) {
      controller.key = key
      expect(WorkspacePanels.hasActiveViewer(controller.asController())).toBe(false)
    }
  })

  it('focuses the selected commit after rendering only for an activating open', async () => {
    const c = new WorkspacePanelsTestController()
    const command: Extract<TabControlCommand, { kind: 'open-commit' }> = { kind: 'open-commit', requestId: 'open', panelId: c.panelId,
      vcs: 'svn', scopeRoot: 'Q:/app', title: 'Commit SVN', messageApplied: true, activate: false }
    await WorkspacePanels.tabControlResult(c.asController(), command)
    expect(c.activated).toEqual([])
    expect(c.focused).toEqual([])
    await WorkspacePanels.tabControlResult(c.asController(), { ...command, activate: true })
    expect(c.activated).toEqual([c.panelId])
    await vi.waitFor(() => expect(c.focused).toEqual([c.panelId]))
    expect(PanelSplitParams.of(c.params).active).toBe(PanelSplitParams.commitKeyOf('svn', 'Q:/app'))
  })

  it('persists different file selections as separate commits beside the directory review', async () => {
    const controller = new WorkspacePanelsTestController()
    const command: Extract<TabControlCommand, { kind: 'open-commit' }> = { kind: 'open-commit', requestId: 'commit', panelId: controller.panelId,
      vcs: 'svn', scopeRoot: 'Q:/app', title: 'Commit SVN', messageApplied: true }
    for (const paths of [undefined, ['Q:/app/one.txt'], ['Q:/app/two.txt']])
      await WorkspacePanels.tabControlResult(controller.asController(), { ...command, paths })
    const items = PanelSplitParams.of(JSON.parse(JSON.stringify(controller.params))).items
    expect(items).toHaveLength(3)
    expect(items[1]).toMatchObject({ paths: ['Q:/app/one.txt'], key: PanelSplitParams.commitKeyOf('svn', 'Q:/app', ['Q:/app/one.txt']) })
    expect(items[2]).toMatchObject({ paths: ['Q:/app/two.txt'] })
  })

  it('keeps the current commit or diff visible when another review arrives in the background', async () => {
    const c = new WorkspacePanelsTestController()
    const command: Extract<TabControlCommand, { kind: 'open-commit' }> = { kind: 'open-commit', requestId: 'open', panelId: c.panelId,
      vcs: 'svn', scopeRoot: 'Q:/app/first', title: 'Commit SVN', messageApplied: true, activate: false }
    await WorkspacePanels.tabControlResult(c.asController(), command)
    const first = PanelSplitParams.of(c.params)
    await WorkspacePanels.tabControlResult(c.asController(), { ...command, scopeRoot: 'Q:/app/second' })
    expect(PanelSplitParams.of(c.params)).toMatchObject({ active: first.active, history: first.history })
    expect(PanelSplitParams.of(c.params).items).toHaveLength(2)

    await WorkspacePanels.tabControlResult(c.asController(), WorkspacePanelsTest.command())
    const diff = PanelSplitParams.of(c.params)
    await WorkspacePanels.tabControlResult(c.asController(), { ...command, scopeRoot: 'Q:/app/third' })
    expect(PanelSplitParams.of(c.params)).toMatchObject({ active: diff.active, history: diff.history, preview: diff.preview })
    expect(c.activated).toEqual([])

    await WorkspacePanels.tabControlResult(c.asController(), { ...command, scopeRoot: 'Q:/app/second', activate: true })
    expect(PanelSplitParams.of(c.params).active).toBe(PanelSplitParams.commitKeyOf('svn', 'Q:/app/second'))
    expect(PanelSplitParams.of(c.params).items).toHaveLength(4)
  })

  it('does not recreate a queued commit closed before its activation reaches the renderer', async () => {
    const c = new WorkspacePanelsTestController()
    const command: Extract<TabControlCommand, { kind: 'open-commit' }> = { kind: 'open-commit', requestId: 'open', panelId: c.panelId,
      vcs: 'svn', scopeRoot: 'Q:/app', title: 'Commit SVN', messageApplied: false }
    await WorkspacePanels.tabControlResult(c.asController(), { ...command, activate: false })
    expect(await WorkspacePanels.tabControlResult(c.asController(), { ...command, activate: true, existingOnly: true }))
      .toMatchObject({ kind: 'commit-opened' })
    const state = PanelSplitParams.of(c.params)
    c.params = PanelSplitParams.merged(c.params, PanelSplitParams.closed(state, state.active!))
    const closed = structuredClone(c.params)
    expect(await WorkspacePanels.tabControlResult(c.asController(), { ...command, activate: true, existingOnly: true }))
      .toEqual({ kind: 'failed', detail: 'The commit dialog is no longer open' })
    expect(c.params).toEqual(closed)
    expect(c.activated).toHaveLength(1)
  })
  it('adds a permanent commit to the terminal split and returns the independent cap refusal', async () => {
    const controller = new WorkspacePanelsTestController()
    const command: Extract<TabControlCommand, { kind: 'open-commit' }> = { kind: 'open-commit', requestId: 'commit', panelId: controller.panelId,
      vcs: 'svn', scopeRoot: 'Q:/app', title: 'Commit SVN', messageApplied: true }
    for (let i = 0; i < 8; i++) expect(await WorkspacePanels.tabControlResult(controller.asController(), { ...command, scopeRoot: `Q:/app/${i}` }))
      .toEqual({ kind: 'commit-opened', panelId: controller.panelId })
    const before = structuredClone(controller.params)
    expect(await WorkspacePanels.tabControlResult(controller.asController(), command)).toMatchObject({ kind: 'failed', detail: expect.stringContaining('8 commit dialogs') })
    expect(controller.params).toEqual(before)
    expect(PanelSplitParams.of(controller.params).preview).toBeNull()
    controller.key = 'fileViewer'
    expect(await WorkspacePanels.tabControlResult(controller.asController(), command)).toMatchObject({ kind: 'failed', detail: expect.stringContaining('Not a terminal panel') })
  })
  it('routes Back to the active split and leaves unrelated panel parameters intact', () => {
    const controller = new WorkspacePanelsTestController()
    controller.params = { sessionId: 'session-one', sidebar: { visible: true }, split: {
      items: [{
        key: 'b', title: 'b.md',
        source: { kind: 'workspace', sessionId: 'session-one', path: 'Q:/Project/b.md' },
      }],
      active: 'b', preview: 'b',
      history: [{
        key: 'a', title: 'a.md',
        source: { kind: 'workspace', sessionId: 'session-one', path: 'Q:/Project/a.md' },
      }],
    } }

    WorkspacePanels.backInSplit(controller.asController())

    expect(PanelSplitParams.of(controller.params).active).toBe('a')
    expect(PanelSplitParams.of(controller.params).history).toEqual([])
    expect(controller.params.sidebar).toEqual({ visible: true })
    expect(controller.writes).toBe(1)
    WorkspacePanels.backInSplit(controller.asController())
    expect(controller.writes).toBe(1)
  })

  it('ignores Back without an active terminal split', () => {
    const controller = new WorkspacePanelsTestController()
    for (const key of [null, PanelKeysConst.fileViewer, PanelKeysConst.terminal]) {
      controller.key = key
      WorkspacePanels.backInSplit(controller.asController())
    }
    expect(controller.writes).toBe(0)
  })

  it('opens a task view in the terminal split, brings the tab forward, and passes on the ninth refusal', async () => {
    const controller = new WorkspacePanelsTestController()
    const command = (subagentId: string): Extract<TabControlCommand, { kind: 'open-task' }> => ({
      kind: 'open-task', requestId: `task-${subagentId}`, panelId: controller.panelId,
      item: { key: `task:session-one:subagent:${subagentId}`, title: `Explore: ${subagentId}`, sessionId: 'session-one',
        task: { kind: 'subagent', subagentId } },
    })

    expect(await WorkspacePanels.tabControlResult(controller.asController(), command('a0')))
      .toEqual({ kind: 'task-opened', panelId: controller.panelId })
    expect(PanelSplitParams.of(controller.params)).toMatchObject({ active: 'task:session-one:subagent:a0', preview: null,
      items: [{ kind: 'task', title: 'Explore: a0', task: { kind: 'subagent', subagentId: 'a0' } }] })
    expect(controller.activated).toEqual([controller.panelId])

    for (let i = 1; i < 8; i++) await WorkspacePanels.tabControlResult(controller.asController(), command(`a${i}`))
    const writes = controller.writes
    expect(await WorkspacePanels.tabControlResult(controller.asController(), command('ninth'))).toEqual({
      kind: 'failed', detail: 'The split already holds 8 task views. Close one before opening another.' })
    expect(controller.writes).toBe(writes)
  })

  it('writes a proven source into the existing terminal panel split', async () => {
    const controller = new WorkspacePanelsTestController()

    expect(await WorkspacePanels.tabControlResult(
      controller.asController(),
      WorkspacePanelsTest.command(),
    )).toEqual({ kind: 'file-opened', panelId: controller.panelId })
    expect(PanelSplitParams.of(controller.params)).toMatchObject({
      active: 'document-report',
      preview: 'document-report',
      items: [{
        key: 'document-report',
        title: 'report.md',
        source: {
          kind: 'workspace',
          sessionId: 'session-one',
          path: 'Q:\\Apps\\Project\\reports\\report.md',
        },
      }],
    })
    expect(JSON.stringify(controller.params)).not.toContain('documentId')
    expect(controller.writes).toBe(1)
  })

  it('fails closed when the exact panel is not a terminal', async () => {
    const controller = new WorkspacePanelsTestController()
    controller.key = PanelKeysConst.fileViewer

    expect(await WorkspacePanels.tabControlResult(
      controller.asController(),
      WorkspacePanelsTest.command(),
    )).toEqual({
      kind: 'failed',
      detail: `Not a terminal panel: ${controller.panelId}`,
    })
    expect(controller.writes).toBe(0)
  })

  it('returns the split cap refusal without changing the panel parameters', async () => {
    const controller = new WorkspacePanelsTestController()
    const items = Array.from({ length: PanelSplitParams.itemsMaxConst }, (_, index) => ({
      kind: 'file' as const,
      key: `document-${index}`,
      title: `file-${index}.md`,
      source: {
        kind: 'workspace' as const,
        sessionId: 'session-one',
        path: `Q:\\Apps\\Project\\file-${index}.md`,
      },
    }))
    controller.params = PanelSplitParams.merged(controller.params, {
      ...PanelSplitParams.default(),
      ratio: 0.5,
      active: items[0]?.key ?? null,
      preview: null,
      items,
    })
    const before = structuredClone(controller.params)

    expect(await WorkspacePanels.tabControlResult(
      controller.asController(),
      WorkspacePanelsTest.command(),
    )).toEqual({
      kind: 'failed',
      detail: 'The split already holds 8 files. Close one before opening another.',
    })
    expect(controller.params).toEqual(before)
  })

  it('closes active split files before it closes the terminal panel', async () => {
    const controller = new WorkspacePanelsTestController()
    const first = WorkspacePanelsTest.item('one')
    const second = WorkspacePanelsTest.item('two')
    const items = [first, second]
    controller.params = PanelSplitParams.merged(controller.params, {
      ...PanelSplitParams.default(),
      ratio: 0.6,
      active: second.key,
      preview: null,
      items,
    })

    await WorkspacePanels.closeActive(controller.asController())
    expect(PanelSplitParams.of(controller.params)).toMatchObject({
      ratio: 0.6,
      active: first.key,
      items: [first],
    })
    expect(controller.hidden).toEqual([])

    await WorkspacePanels.closeActive(controller.asController())
    expect(PanelSplitParams.of(controller.params)).toMatchObject({
      ratio: 0.6,
      active: null,
      items: [],
    })
    expect(controller.hidden).toEqual([])

    await WorkspacePanels.closeActive(controller.asController())
    expect(controller.hidden).toEqual([controller.panelId])
    expect(controller.writes).toBe(2)
  })

  it('closes the whole terminal panel when the active split file is pinned', async () => {
    const controller = new WorkspacePanelsTestController()
    const loose = WorkspacePanelsTest.item('loose')
    const pinned = { ...WorkspacePanelsTest.item('pinned'), pinned: true as const }
    controller.params = PanelSplitParams.merged(controller.params, {
      ...PanelSplitParams.default(),
      active: pinned.key,
      items: [loose, pinned],
    })
    const before = structuredClone(controller.params)

    await WorkspacePanels.closeActive(controller.asController())
    expect(controller.hidden).toEqual([controller.panelId])
    expect(controller.params).toEqual(before)
  })
})

class WorkspacePanelsTest {
  static item(name: string) {
    return {
      kind: 'file' as const,
      key: `document-${name}`,
      title: `${name}.md`,
      source: {
        kind: 'workspace' as const,
        sessionId: 'session-one',
        path: `Q:\\Apps\\Project\\${name}.md`,
      },
    }
  }

  static command(): Extract<TabControlCommand, { kind: 'open-file' }> {
    return {
      kind: 'open-file',
      requestId: 'request-file',
      panelId: 'terminal:{"sessionId":"session-one"}',
      source: {
        kind: 'workspace',
        sessionId: 'session-one',
        path: 'Q:\\Apps\\Project\\reports\\report.md',
      },
      documentKey: 'document-report',
      title: 'report.md',
    }
  }
}

describe('Session actions panel routing', () => {
  afterEach(() => vi.unstubAllGlobals())

  const target = { kind: 'remote', remoteEndpointId: 'peer', sessionId: 'session' } as const

  it('forwards opening the split to the main broker when another window owns the terminal', async () => {
    const openSessionActions = vi.fn(async () => ({ ok: true, value: undefined }))
    const openSharedItem = vi.fn(async () => ({ ok: true, value: { ok: true, value: {} } }))
    const closeView = vi.fn(async () => ({ ok: true, value: undefined }))
    vi.stubGlobal('appClient', { tabs: { openSessionActions }, remote: { openSharedItem, closeView,
      openView: async () => ({ ok: true, value: { ok: true, value: { viewId: 'view' } } }) } })
    const controller = {
      openPanel: async () => ({ kind: 'focusedExisting', panelId: 'remote', windowId: 'holder' }),
      applyPanelParameters: () => false,
    } as unknown as TabsController
    await WorkspacePanels.openSessionActions(controller, target, 'Remote')
    expect(openSessionActions).toHaveBeenCalledWith(target)
    expect(openSharedItem).toHaveBeenCalledExactlyOnceWith(target.remoteEndpointId, 'view', { openId: expect.any(String), item: { kind: 'workflow' } })
    expect(closeView).toHaveBeenCalledOnce()
  })

  it.each(['local', 'remote'] as const)('publishes an intentional %s Session actions open once and never republishes a projected command', async (kind) => {
    const chosen = kind === 'remote' ? target : { kind: 'local' as const, sessionId: 'session' }
    const openSharedItem = vi.fn(async () => ({ ok: true, value: { ok: true, value: {} } }))
    const closeView = vi.fn(async () => ({ ok: true, value: undefined }))
    vi.stubGlobal('appClient', { tabs: { openSharedItem }, remote: { openSharedItem, closeView,
      openView: async () => ({ ok: true, value: { ok: true, value: { viewId: 'view' } } }) } })
    let params: Record<string, unknown> = kind === 'remote' ? { target: chosen } : { sessionId: 'session' }
    const controller = { openPanel: async () => ({ kind: 'opened', panelId: 'panel' }), keyOf: () => 'terminal',
      focusPanelContent: vi.fn(), activatePanel: vi.fn(),
      applyPanelParameters: (_id: string, merge: (value: Record<string, unknown>) => Record<string, unknown>) => { params = merge(params); return true },
    } as unknown as TabsController
    await WorkspacePanels.openSessionActions(controller, chosen, 'Session')
    expect(openSharedItem).toHaveBeenCalledOnce()
    expect(PanelSplitParams.of(params).items).toHaveLength(1)
    await WorkspacePanels.tabControlResult(controller, { kind: 'open-workflow', requestId: 'projected', panelId: 'panel', sessionId: 'session', target: chosen })
    expect(openSharedItem).toHaveBeenCalledOnce()
    expect(closeView).toHaveBeenCalledTimes(kind === 'remote' ? 1 : 0)
  })

  it('forwards a remote task to its owner and shares once only after acknowledgement', async () => {
    const task = { kind: 'shell', shellId: 'same' } as const
    const openSessionTask = vi.fn(async () => ({ ok: true, value: undefined }))
    const openSharedItem = vi.fn(async () => ({ ok: true, value: { ok: true, value: {} } }))
    const closeView = vi.fn(async () => ({ ok: true, value: undefined }))
    vi.stubGlobal('appClient', { tabs: { openSessionTask }, remote: { openSharedItem, closeView,
      openView: async () => ({ ok: true, value: { ok: true, value: { viewId: 'view' } } }) } })
    const controller = { openPanel: async () => ({ kind: 'focusedExisting', panelId: 'remote', windowId: 'holder' }),
      keyOf: () => null } as unknown as TabsController
    await WorkspacePanels.openTask(controller, target, task, 'Shell')
    expect(openSessionTask).toHaveBeenCalledExactlyOnceWith(target, task, 'Shell')
    expect(openSharedItem).toHaveBeenCalledExactlyOnceWith(target.remoteEndpointId, 'view', { openId: expect.any(String), item: { kind: 'task', task } })
    expect(closeView).toHaveBeenCalledOnce()
  })

  it('opens the qualified workflow in the owning window and refuses a foreign target', async () => {
    let params: Record<string, unknown> = { target }
    const activatePanel = vi.fn()
    const controller = {
      keyOf: () => 'terminal', activatePanel, focusPanelContent: vi.fn(),
      applyPanelParameters: (_id: string, merge: (value: Record<string, unknown>) => Record<string, unknown>) => {
        params = merge(params)
        return true
      },
    } as unknown as TabsController
    const command = { kind: 'open-workflow', requestId: 'one', panelId: 'remote', sessionId: 'session', target } as const
    expect(await WorkspacePanels.tabControlResult(controller, command)).toEqual({ kind: 'workflow-opened', panelId: 'remote' })
    expect(PanelSplitParams.of(params).items).toEqual([PanelSplitParams.workflowItemOf('session', target)])
    expect(await WorkspacePanels.tabControlResult(controller, { ...command, target: { ...target, remoteEndpointId: 'foreign' } }))
      .toEqual({ kind: 'failed', detail: 'The session terminal target has changed' })
    expect(activatePanel).toHaveBeenCalledTimes(1)
  })
})
