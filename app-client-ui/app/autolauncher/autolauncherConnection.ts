import { createHmac, randomBytes } from 'node:crypto'
import { request } from 'node:http'
import { isIPv4 } from 'node:net'
import { networkInterfaces } from 'node:os'

import { RemoteLauncherConfig } from '../../../lib-orchestrator/remoteControl/remoteLauncherConfig'
import { AutolauncherProblem } from './autolauncherProblem'

export interface AutolauncherPairing {
  publicUrl: string
  key: string
  gatewayAddress: string
}

export class AutolauncherConnection {
  async pair(invitation: unknown): Promise<AutolauncherPairing> {
    if (typeof invitation !== 'string' || invitation.length > 1024)
      throw new AutolauncherProblem('Paste the setup invitation from MiniWolService.')
    let url: URL
    try { url = new URL(invitation.trim()) }
    catch { throw new AutolauncherProblem('The setup invitation is invalid.') }
    const match = /^#autolauncher=([a-f0-9]{64})$/.exec(url.hash)
    if (!match || url.username || url.password || url.pathname !== '/' || url.search)
      throw new AutolauncherProblem('The setup invitation is invalid.')
    try { RemoteLauncherConfig.origin(url.origin) }
    catch { throw new AutolauncherProblem('The setup invitation is invalid.') }
    const payload = JSON.stringify({ token: match[1] })
    try {
      const value = await this.read(new URL('/api/launcher-pair', url.origin), 'POST', {
        'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)),
      }, payload)
      const pairing = AutolauncherConnection.parse(value)
      if (pairing.gatewayAddress !== url.hostname)
        throw new Error('Unexpected gateway address')
      const local = Object.values(networkInterfaces()).flat().some(info =>
        info?.family === 'IPv4' && info.address === new URL(pairing.publicUrl).hostname)
      if (!local) throw new Error('Invitation belongs to another computer')
      return pairing
    } catch {
      throw new AutolauncherProblem('Pairing failed. Create a new invitation for this PC in MiniWolService and try again.')
    }
  }

  async probe(pairing: AutolauncherPairing): Promise<boolean> {
    const timestamp = String(Date.now())
    const nonce = randomBytes(16).toString('hex')
    const signature = createHmac('sha256', Buffer.from(pairing.key, 'hex'))
      .update(`GET\n/api/status\n${timestamp}\n${nonce}`).digest('hex')
    try {
      const value = await this.read(new URL('/api/status', pairing.publicUrl), 'GET', {
        'X-Jamat-Timestamp': timestamp, 'X-Jamat-Nonce': nonce, 'X-Jamat-Signature': signature,
      })
      return typeof value === 'object' && value !== null && !Array.isArray(value) && 'state' in value
        && typeof value.state === 'string' && ['stopped', 'starting', 'ready', 'failed'].includes(value.state)
        && Object.keys(value).every(key => key === 'state' || key === 'error')
        && (!('error' in value) || typeof value.error === 'string')
    } catch { return false }
  }

  static parse(value: unknown): AutolauncherPairing {
    if (typeof value !== 'object' || value === null || Array.isArray(value)
      || Object.keys(value).length !== 3 || !('publicUrl' in value) || !('key' in value)
      || !('gatewayAddress' in value) || typeof value.key !== 'string'
      || !/^[a-f0-9]{64}$/i.test(value.key) || typeof value.gatewayAddress !== 'string'
      || !isIPv4(value.gatewayAddress))
      throw new Error('Invalid launcher pairing')
    return { publicUrl: RemoteLauncherConfig.origin(value.publicUrl), key: value.key,
      gatewayAddress: value.gatewayAddress }
  }

  private read(url: URL, method: 'GET' | 'POST', headers: Record<string, string>, body?: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const req = request(url, { method, headers, agent: false, signal: AbortSignal.timeout(3000) }, response => {
        if (response.statusCode !== 200 || response.headers['content-encoding']
          || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers['content-type'] ?? '')) {
          response.destroy()
          reject(new Error('Invalid launcher response'))
          return
        }
        const chunks: Buffer[] = []
        let size = 0
        response.on('error', reject)
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > 16 * 1024) {
            response.destroy()
            reject(new Error('Launcher response exceeded limit'))
          } else chunks.push(chunk)
        })
        response.on('end', () => {
          try { resolve(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))) }
          catch { reject(new Error('Invalid launcher response')) }
        })
      })
      req.on('error', reject)
      req.end(body)
    })
  }
}
