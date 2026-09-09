import type {
  HostDebugRuntimeRow,
  HostDebugStatus,
} from '../../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { DebugTimeFormat } from '../debugTimeFormat'
import type { HostDebugState } from './hostDebugModel'

/**
 * Every block of the host screens as label and value pairs. The components draw a list; which fields
 * a block holds and how each reads is decided here, where it can be tested without a DOM.
 */
export class HostDebugFacts {
  static ping(state: HostDebugState): readonly [string, string][] {
    const ping = state.lastPing
    if (ping === null)
      return [['Last', state.pinging ? 'asking…' : 'never asked']]
    if (!ping.ok)
      return [['Last', DebugTimeFormat.at(ping.at)], ['Answer', `failed - ${ping.detail}`]]
    return [
      ['Last', DebugTimeFormat.at(ping.at)],
      ['Latency', `${ping.latencyMilliseconds} ms`],
      ['Build', `${ping.hello.buildVersion} (${ping.hello.sourceRevision})`],
      ['Platform', `${ping.hello.platform} ${ping.hello.arch}`],
      ['Protocol', `${ping.hello.protocol.major}.${ping.hello.protocol.minor}`],
      ['Generation', ping.hello.hostGeneration],
      ['Pid', String(ping.hello.pid)],
      ['Runtimes', `${ping.hello.runtimesLive} live · ${ping.hello.runtimesDead} dead`],
      ['Event revision', String(ping.hello.eventRevision)],
    ]
  }

  static descriptor(status: HostDebugStatus, now: number): readonly [string, string][] {
    const descriptor = status.descriptor
    if (descriptor === null)
      return [['Published', 'no descriptor on disk']]
    return [
      ['Pid', String(descriptor.pid)],
      ['Port', String(descriptor.port)],
      ['Version', `${descriptor.hostVersion} (tree: ${status.expectedHostVersion ?? '?'})`],
      ['Protocol', `${descriptor.protocol.major}.${descriptor.protocol.minor} `
        + `(client: ${status.clientProtocol.major}.${status.clientProtocol.minor})`],
      ['Instance', descriptor.hostInstanceId],
      ['Generation', descriptor.hostGeneration],
      ['Channel', descriptor.runtimeChannel],
      ['Config identity', descriptor.configIdentity],
      ['Payload hash', descriptor.payloadHash],
      ['Capabilities', descriptor.capabilities.join(', ')],
      ['Serving since', `${DebugTimeFormat.at(descriptor.startedAt)} `
        + `(${HostDebugFormat.since(descriptor.startedAt, now)})`],
      ['Process since', DebugTimeFormat.at(descriptor.processStartedAt)],
    ]
  }

  static launch(status: HostDebugStatus): readonly [string, string][] {
    const launch = status.launch
    if (!launch.ok)
      return [
        ['Can start one', `no - ${launch.refusal ?? 'no reason given'}`],
        ['Last start error', status.controller.lastStartError ?? 'none'],
      ]
    return [
      ['Command', launch.command ?? '—'],
      ['Arguments', launch.args.join(' ')],
      ['Working directory', launch.cwd ?? '—'],
      ['Auto-start spent', HostDebugFormat.flag(status.controller.autoStartAttempted)],
      ['Launching now', HostDebugFormat.flag(status.controller.launching)],
      ['Last start error', status.controller.lastStartError ?? 'none'],
    ]
  }

  static watcher(status: HostDebugStatus): readonly [string, string][] {
    return [
      ['File', status.watcher.descriptorFile],
      ['Every', `${status.watcher.pollMilliseconds} ms`],
      ['Holding', status.watcher.identity ?? 'nothing'],
    ]
  }

  static eventsSocket(status: HostDebugStatus): readonly [string, string][] {
    const socket = status.eventsSocket
    const facts: [string, string][] = [
      ['Connected', HostDebugFormat.flag(socket.connected)],
      ['Cursor', HostDebugFormat.number(socket.cursor)],
      ['Resync owed', HostDebugFormat.flag(socket.resyncOwed)],
      ['Reconnect attempt', String(socket.reconnectAttempt)],
    ]
    if (socket.lastSubscribed !== null)
      facts.push(['Last subscribe', `${DebugTimeFormat.at(socket.lastSubscribed.at)} · through `
        + `#${socket.lastSubscribed.throughRevision} · ${socket.lastSubscribed.replayed} replayed`
        + `${socket.lastSubscribed.truncated ? ' · truncated' : ''}`])
    return facts
  }

  static lease(status: HostDebugStatus, now: number): readonly [string, string][] {
    const lease = status.lease
    return [
      ['Controller', lease.controllerId],
      ['Lease', lease.leaseId ?? 'none'],
      ['Expires', lease.expiresAt === null
        ? '—'
        : `${DebugTimeFormat.at(lease.expiresAt)} (${HostDebugFormat.until(lease.expiresAt, now)})`],
    ]
  }

  static reconcile(status: HostDebugStatus): readonly [string, string][] {
    return [
      ['Last pass', DebugTimeFormat.at(status.reconcile.lastAt)],
      ['Because of', status.reconcile.lastReason ?? 'nothing yet'],
      ['Listing answered', status.reconcile.lastListingOk === null
        ? '—'
        : HostDebugFormat.flag(status.reconcile.lastListingOk)],
      ['Refresh pending', HostDebugFormat.flag(status.reconcile.refreshPending)],
    ]
  }

  static poll(status: HostDebugStatus): readonly [string, string][] {
    return [
      ['A window is visible', HostDebugFormat.flag(status.poll.windowVisible)],
      ['Cadence', `${status.poll.cadenceMilliseconds} ms`],
      ['Last tick', DebugTimeFormat.at(status.poll.lastTickAt)],
      ['Composed at', DebugTimeFormat.at(status.capturedAt)],
    ]
  }
}

/**
 * What only the host screens read: a length measured either side of now, a flag, a nullable number,
 * and what became of a runtime. The clock time and the length itself are `DebugTimeFormat`'s, shared
 * with the rate section beside this one.
 */
export class HostDebugFormat {
  static since(value: number, now: number): string {
    return DebugTimeFormat.duration(Math.max(0, now - value))
  }

  static until(value: number, now: number): string {
    if (value <= now)
      return 'expired'
    return `in ${DebugTimeFormat.duration(value - now)}`
  }

  static number(value: number | null): string {
    return value === null ? '—' : String(value)
  }

  static flag(value: boolean): string {
    return value ? 'yes' : 'no'
  }

  static life(row: HostDebugRuntimeRow): string {
    if (row.alive)
      return 'alive'
    const code = row.exitCode === null ? '' : ` (${row.exitCode})`
    return `exited${code} ${row.exitReason ?? ''}`.trim()
  }

  /**
   * The classifier's verdict and what it rested on. The signals are what makes this worth a column:
   * a hint alone says the answer, and the day the answer is wrong it is the signal list that says
   * which window saw what.
   */
  static work(row: HostDebugRuntimeRow): string {
    if (row.work === null) return '—'
    if (row.work.signals.length === 0) return row.work.hint
    return `${row.work.hint} · ${row.work.signals.join(' ')}`
  }
}
