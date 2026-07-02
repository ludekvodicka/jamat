/**
 * Remote App Control — local config IPC (this machine's server token, enable
 * flag, listen port, and peer list). The client-side calls TO a peer
 * (probe/windows/open-tab/launch/stream) live in `remote-client.ts`.
 */

import { networkInterfaces, hostname } from 'node:os'
import { registerHandler } from '../shared/typed-ipc'
import { getRemoteControl, saveRemoteControl, getSelfName } from './remote-control-store'
import { reconcileOpServer, getBindState } from './op-server'

// Rank private-LAN addresses first (the one a peer most likely needs).
function lanRank(ip: string): number {
  if (ip.startsWith('192.168.')) return 0
  if (ip.startsWith('10.')) return 1
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return 2
  return 3
}

export function registerRemoteConfigIpc(): void {
  registerHandler('remote:get-config', async () => getRemoteControl())
  registerHandler('remote:get-bind-state', async () => getBindState())

  // This machine's instance-id `<machine>` prefix — used by the renderer to mint a tab's
  // instance id on "Copy instance id" without pulling the whole (secret-bearing) config.
  registerHandler('remote:self-name', async () => getSelfName())

  registerHandler('remote:local-ips', async () => {
    const ips: string[] = []
    for (const ifaces of Object.values(networkInterfaces())) {
      for (const i of ifaces ?? []) {
        if (i.family === 'IPv4' && !i.internal) ips.push(i.address)
      }
    }
    ips.sort((a, b) => lanRank(a) - lanRank(b) || a.localeCompare(b))
    return { hostname: hostname(), ips }
  })

  registerHandler('remote:save-config', async (_e, data) => {
    const res = saveRemoteControl(data)
    // Apply enable/port changes live (start or stop the LAN listener) so the
    // server section's toggle takes effect without an app restart.
    if (res.ok) reconcileOpServer()
    return res
  })
}
