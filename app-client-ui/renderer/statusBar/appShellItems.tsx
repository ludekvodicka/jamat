import type { RateMonitorSnapshot } from '../../../lib-orchestrator/rateMonitor/rateMonitorApi.types'
import type { AppInfo } from '../../shared/appClientUiIpc'
import type { WindowInfo } from '../../shared/windowInfo'
import type { SessionCompact } from '../contextCompaction/sessionCompact'
import { SnapshotStore } from '../ipc/snapshotStore'
import type { AppShellHostStatus } from '../shell/appShell.types'
import { HostStatusItem } from './hostStatusItem'
import { RateStatusItem, type RateStatusPorts } from './rateStatusItem'
import { SessionModelItem } from './sessionModelItem'
import type { SessionModelCurrent } from '../sessionModel/sessionModelStore'
import type { StatusBarItem } from './statusBar'
import type { ActiveAgentTerminal } from './useActiveAgentTerminal'

/**
 * What a workspace's status bar carries, on each side. Beside the bar it fills rather than in the
 * shell that calls it: it draws items and reads nothing, which is the bar's own job, and the shell
 * was the only place anybody could find it.
 */
export class AppShellItems {
  /**
   * The version, and the Host beside it: both say what this window is running on, so they are read
   * in one place rather than one at each end of the bar. The Host item does not wait for app:info -
   * it reads its own state and says so itself, which is the point of the bar staying layout-only.
   */
  static left(
    appInfo: AppInfo | null,
    hostStatus: AppShellHostStatus | null,
  ): readonly StatusBarItem[] {
    const items: StatusBarItem[] = []
    // Before app:info answers there is no version to draw, rather than a placeholder reading.
    if (appInfo)
      items.push({ key: 'version', node: <span>{`v${appInfo.appVersion}`}</span> })
    if (hostStatus !== null)
      items.push({
        key: 'host',
        node: <HostStatusItem ports={hostStatus.ports} snapshotStore={hostStatus.snapshot} />,
      })
    return items
  }

  /**
   * `window · sessionModel · rate · channel`: the two terminal widgets sit between the window's name
   * and the channel, because what they say changes while the window is open and the two beside them
   * never do.
   *
   * Both are about the tab in front, so both are drawn only when that tab is an agent's terminal.
   * This supersedes the earlier decision to draw the usage widget unconditionally ("a slot that
   * disappears is how a user never learns the reading exists"): V1 hid it, the user asked for V1's
   * behaviour, and the placeholder was the thing that had to go. They appear and disappear on the
   * SAME signal, so the right group reflows once per switch rather than twice, and both draw
   * monospace, so moving from one agent's tab to another's does not move them at all.
   *
   * The model widget also needs something read before it can say anything, and a widget that renders
   * nothing still leaves its slot and its separator behind - so whether it exists is decided here,
   * where the slot is, rather than inside it.
   */
  static right(
    appInfo: AppInfo | null,
    windowInfo: WindowInfo | null,
    focus: ActiveAgentTerminal | null,
    widgets: {
      sessionModel: SessionModelCurrent | null
      /**
       * The operation the model widget's Compact button shares with the panel and command menu.
       */
      compact: SessionCompact
      rate: { ports: RateStatusPorts; store: SnapshotStore<RateMonitorSnapshot> }
    },
  ): readonly StatusBarItem[] {
    const items: StatusBarItem[] = []
    if (windowInfo?.name !== null && windowInfo?.name !== undefined)
      items.push({ key: 'window', node: <span>{windowInfo.name}</span> })
    if (focus !== null) {
      if (widgets.sessionModel !== null)
        items.push({
          key: 'session-model',
          node: <SessionModelItem reading={widgets.sessionModel} compact={widgets.compact} />,
        })
      items.push({
        key: 'rate',
        node: (
          <RateStatusItem
            agentId={focus.agentId}
            ports={widgets.rate.ports}
            store={widgets.rate.store}
          />
        ),
      })
    }
    if (appInfo)
      items.push({ key: 'channel', node: <span>{appInfo.runtimeChannel}</span> })
    return items
  }
}
