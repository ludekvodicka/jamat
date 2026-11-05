import type { ShellPort, ShellNotice } from '../../../lib-orchestrator/shared/shellPort.types'
import type { ShellSnapshot } from '../../../lib-orchestrator/clientApi/orchestratorProcess.types'
import type { ProcessCalls, ProcessCallContext } from '../../../lib-orchestrator/shared/processCalls'
import type { TabRequestPort } from '../../../lib-orchestrator/shared/tabRequestPort.types'

export class ShellPortServer {
  private readonly shell: ShellPort
  private readonly calls: Pick<ProcessCalls, 'emit'>
  private readonly read: () => ShellSnapshot
  private readonly unsubscribe: (() => void)[]

  constructor(shell: ShellPort, calls: ShellPortServer['calls'], read: () => ShellSnapshot) {
    this.shell = shell
    this.calls = calls
    this.read = read
    this.unsubscribe = [shell.onNotice((id, event) => { calls.emit('shell', 'notice', { id, event }) }),
      shell.sessionGroups.onChanged(() => this.changed())]
  }

  snapshot(): ShellSnapshot { return this.read() }
  changed(): void { this.calls.emit('shell', 'snapshot', this.read()) }
  async invoke(method: string, args: unknown[], context: ProcessCallContext): Promise<unknown> {
    context.pending()
    const shell = this.shell
    switch (method) {
      case 'confirm': return shell.confirm(...args as Parameters<ShellPort['confirm']>)
      case 'saveDialog': return shell.saveDialog(...args as Parameters<ShellPort['saveDialog']>)
      case 'cipher.available': return shell.cipher.available()
      case 'cipher.encrypt': return shell.cipher.encrypt(...args as Parameters<ShellPort['cipher']['encrypt']>)
      case 'cipher.decrypt': return shell.cipher.decrypt(...args as Parameters<ShellPort['cipher']['decrypt']>)
      case 'openPath': return shell.openPath(...args as Parameters<ShellPort['openPath']>)
      case 'openExternal': return shell.openExternal(...args as Parameters<ShellPort['openExternal']>)
      case 'clipboardForPaste': return shell.clipboardForPaste()
      case 'restart': return shell.restart(...args as Parameters<ShellPort['restart']>)
      case 'groups.assign': return shell.sessionGroups.assign(...args as Parameters<ShellPort['sessionGroups']['assign']>)
      case 'tabs.request': {
        const result = await shell.tabs.request(...args as Parameters<TabRequestPort['request']>)
        this.changed()
        return result
      }
      default: throw new Error('Unknown shell request: ' + method)
    }
  }
  event(name: string, payload: unknown): void {
    switch (name) {
      case 'notify': this.shell.notify(payload as ShellNotice); return
      case 'quit': this.shell.quit(); return
      default: throw new Error('Unknown shell event: ' + name)
    }
  }
  stop(): void { for (const unsubscribe of this.unsubscribe) unsubscribe() }
}
