import type { ShellPort, ShellConfirmRequest, ShellNotice, ShellClipboardRead, ShellSecretCipher, ShellSessionGroups } from '../../../lib-orchestrator/shared/shellPort.types'
import type { TabRequestPort, TabPanelSnapshot, TabPanelOwner } from '../../../lib-orchestrator/shared/tabRequestPort.types'
import type { ShellSnapshot } from '../../../lib-orchestrator/clientApi/orchestratorProcess.types'
import type { ProcessCalls } from '../../../lib-orchestrator/shared/processCalls'

export class ShellPortClient implements ShellPort {
  readonly cipher: ShellSecretCipher
  readonly sessionGroups: ShellSessionGroups
  readonly tabs: TabRequestPort
  private readonly calls: Pick<ProcessCalls, 'call' | 'emit'>
  private state: ShellSnapshot
  private groupGeneration: number
  private readonly groupListeners: Set<Parameters<ShellSessionGroups['onChanged']>[0]>
  private readonly noticeListeners: Set<Parameters<ShellPort['onNotice']>[0]>

  constructor(calls: ShellPortClient['calls'], initial: ShellSnapshot) {
    this.calls = calls
    this.state = structuredClone(initial)
    this.groupGeneration = 0
    this.groupListeners = new Set()
    this.noticeListeners = new Set()
    this.cipher = {
      available: () => calls.call('shell', 'cipher.available', []),
      encrypt: value => calls.call('shell', 'cipher.encrypt', [value]),
      decrypt: value => calls.call('shell', 'cipher.decrypt', [value]),
    }
    this.sessionGroups = {
      assignments: () => structuredClone(this.state.groups),
      assign: async change => {
        const generation = this.groupGeneration
        const result = await calls.call<Awaited<ReturnType<ShellSessionGroups['assign']>>>('shell', 'groups.assign', [change])
        if (result.ok && generation === this.groupGeneration) this.update({ ...this.state, groups: result.assignments })
        return result
      },
      onChanged: listener => { this.groupListeners.add(listener); return () => { this.groupListeners.delete(listener) } },
    }
    this.tabs = {
      snapshot: () => this.panels(),
      ownerOf: panelId => this.state.panels.find(panel => panel.panelId === panelId)?.windowId ?? null,
      panelsOfSession: sessionId => this.owners(panel => panel.sessionId === sessionId),
      panelsOfTerminalTarget: key => this.owners(panel => panel.terminalTargetKey === key),
      lastFocusedWindowId: () => this.state.lastFocusedWindowId,
      request: ((windowId, command) => calls.call('shell', 'tabs.request', [windowId, command])) as TabRequestPort['request'],
    }
  }

  update(state: ShellSnapshot): void {
    const changed = JSON.stringify(state.groups) !== JSON.stringify(this.state.groups)
    this.state = structuredClone(state)
    if (changed) {
      this.groupGeneration += 1
      for (const listener of this.groupListeners) listener(this.sessionGroups.assignments())
    }
  }
  notice(id: string, event: 'clicked' | 'closed'): void {
    if (event !== 'clicked' && event !== 'closed') throw new Error('Unknown notice event')
    for (const listener of this.noticeListeners) listener(id, event)
  }
  confirm(request: ShellConfirmRequest): Promise<boolean> { return this.calls.call('shell', 'confirm', [request]) }
  saveDialog(request: Parameters<ShellPort['saveDialog']>[0]): Promise<string | null> { return this.calls.call('shell', 'saveDialog', [request]) }
  notify(notice: ShellNotice): void { this.calls.emit('shell', 'notify', notice) }
  onNotice(listener: Parameters<ShellPort['onNotice']>[0]): () => void {
    this.noticeListeners.add(listener)
    return () => { this.noticeListeners.delete(listener) }
  }
  openPath(path: string): Promise<void> { return this.calls.call('shell', 'openPath', [path]) }
  openExternal(url: string): Promise<void> { return this.calls.call('shell', 'openExternal', [url]) }
  clipboardForPaste(): Promise<ShellClipboardRead> { return this.calls.call('shell', 'clipboardForPaste', []) }
  restart(reason: string): Promise<boolean> { return this.calls.call('shell', 'restart', [reason]) }
  quit(): void { this.calls.emit('shell', 'quit', null) }
  dispose(): void { this.groupListeners.clear(); this.noticeListeners.clear() }

  private panels(): TabPanelSnapshot[] {
    return this.state.panels.map(({ terminalTargetKey: _target, ...panel }) => structuredClone(panel))
  }
  private owners(select: (panel: ShellSnapshot['panels'][number]) => boolean): TabPanelOwner[] {
    return this.state.panels.filter(select).map(({ windowId, active: _active, terminalTargetKey: _target, ...panel }) => ({ windowId, panel: structuredClone(panel) }))
  }
}
