import { describe, expect, it, vi } from 'vitest'

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
