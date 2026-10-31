import { createServer } from 'node:http'
import { isIPv4 } from 'node:net'
import { readFileSync } from 'node:fs'
import { timingSafeEqual } from 'node:crypto'
import { sendWakePacket } from './wol.mjs'
import { callLauncher, launcherStatus, parseLauncher } from './launcher.mjs'
import { LauncherInvitations, readPairingToken } from './pairing.mjs'

/** @typedef {{id: string, label: string, mac: string, launcher?: import('./launcher.mjs').LauncherConfig}} Computer */
/** @typedef {{publicUrl: string, broadcast: string, computers: Computer[]}} Config */

/** @param {unknown} value @returns {string} */
export function parseApiKey(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))
    throw new Error('JAMAT_V3_WOL_API_KEY must contain 64 lowercase hexadecimal characters')
  return value
}

/** @param {string} source @returns {Config} */
export function parseConfig(source) {
  let config
  try {
    config = JSON.parse(source)
  } catch {
    throw new Error('Config must contain valid JSON')
  }
  if (!config || typeof config.publicUrl !== 'string' || typeof config.broadcast !== 'string')
    throw new Error('Config requires publicUrl, broadcast and computers')
  const url = new URL(config.publicUrl)
  if (url.protocol !== 'http:' || !isIPv4(url.hostname) || url.pathname !== '/' || url.search || url.hash || url.username || url.password)
    throw new Error('publicUrl must be an HTTP IPv4 origin, for example http://198.51.100.10:9009')
  if (!isIPv4(config.broadcast))
    throw new Error('broadcast must be an IPv4 address')
  if (!Array.isArray(config.computers) || !config.computers.length)
    throw new Error('Config requires at least one computer')
  const ids = new Set()
  /** @type {Computer[]} */
  const computers = []
  for (const computer of config.computers) {
    if (!computer || typeof computer.id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(computer.id) || ids.has(computer.id))
      throw new Error('Computer ids must be unique lowercase names')
    if (typeof computer.label !== 'string' || !computer.label.trim() || computer.label.length > 80)
      throw new Error('Computer label must contain 1 to 80 characters')
    if (typeof computer.mac !== 'string' || !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(computer.mac))
      throw new Error('Computer MAC must contain six colon-separated hex bytes')
    ids.add(computer.id)
    computers.push({ id: computer.id, label: computer.label, mac: computer.mac,
      ...(Object.hasOwn(computer, 'launcher') ? { launcher: parseLauncher(computer.launcher) } : {}) })
  }
  return { publicUrl: url.origin, broadcast: config.broadcast, computers }
}

/** @param {Config} config @param {{apiKey: string, buildTime?: string}} options */
export function createWolServer(config, options) {
  const apiKey = Buffer.from(parseApiKey(options.apiKey), 'hex')
  const publicUrl = new URL(config.publicUrl)
  const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
  const invitations = new LauncherInvitations()
  /** @type {Map<string, number>} */
  const cooldowns = new Map()
  let pairingRequests = 0

  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Referrer-Policy', 'same-origin')
    /** @param {number} status @param {string} message */
    const error = (status, message) => {
      if (request.url?.startsWith('/api/v1/')) {
        response.writeHead(status, { 'Content-Type': 'application/json', Connection: 'close' })
        return response.end(JSON.stringify({ error: status === 421 ? 'forbidden' : 'bad-request' }))
      }
      response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' })
      response.end(message)
    }
    if (request.headers.host !== publicUrl.host
      || request.rawHeaders.filter((name, index) => index % 2 === 0 && name.toLowerCase() === 'host').length !== 1)
      return error(421, 'Použijte nastavenou adresu služby.')
    let url
    try {
      url = new URL(request.url ?? '/', publicUrl)
    } catch {
      return error(400, 'Neplatná adresa požadavku.')
    }
    if (!request.url?.startsWith('/') || request.url.startsWith('//') || url.origin !== publicUrl.origin || url.hash)
      return error(400, 'Neplatná adresa požadavku.')
    if (url.pathname === '/api/launcher-pair') {
      if (request.method !== 'POST' || request.url !== '/api/launcher-pair')
        return error(404, 'Stránka nebyla nalezena.')
      const denied = 'Pozvánku nelze použít. Vytvořte novou a použijte ji na určeném počítači.'
      if (request.headers.origin !== undefined)
        return error(403, denied)
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')
        || request.headers['content-encoding'] !== undefined
        || Number(request.headers['content-length'] ?? 0) > 1024)
        return error(400, denied)
      if (pairingRequests >= 16)
        return error(503, denied)
      pairingRequests++
      try {
        const token = await readPairingToken(request)
        const launcher = invitations.redeem(token, request.socket.remoteAddress)
        if (!launcher)
          return error(403, denied)
        response.writeHead(200, { 'Content-Type': 'application/json' })
        return response.end(JSON.stringify({ publicUrl: launcher.url, key: launcher.key, gatewayAddress: publicUrl.hostname }))
      } catch {
        return error(400, denied)
      } finally {
        pairingRequests--
      }
    }
    if (request.method === 'GET' && url.pathname === '/api/system/health') {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      return response.end(JSON.stringify({ ok: true }))
    }
    if (request.method === 'GET' && url.pathname === '/api/system/version') {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      return response.end(JSON.stringify({ version, buildTime: options.buildTime ?? 'dev' }))
    }
    if (url.pathname.startsWith('/api/v1/')) {
      /** @param {number} status @param {unknown} body */
      const json = (status, body) => {
        response.writeHead(status, { 'Content-Type': 'application/json', Connection: 'close' })
        response.end(JSON.stringify(body))
      }
      const bearer = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.authorization ?? '')
      if (!bearer || request.rawHeaders.filter((name, index) => index % 2 === 0 && name.toLowerCase() === 'authorization').length !== 1
        || !timingSafeEqual(Buffer.from(bearer[1], 'hex'), apiKey))
        return json(401, { error: 'unauthorized' })
      if (request.headers.origin !== undefined)
        return json(403, { error: 'forbidden' })
      if (request.url !== url.pathname)
        return json(404, { error: 'not-found' })
      const match = /^\/api\/v1\/computers\/([a-z0-9-]{1,40})\/(launcher|wake|start|invitation)$/.exec(url.pathname)
      if (url.pathname !== '/api/v1/computers' && !match)
        return json(404, { error: 'not-found' })
      const action = match?.[2] ?? 'computers'
      if (request.method !== (action === 'computers' || action === 'launcher' ? 'GET' : 'POST'))
        return json(405, { error: 'method-not-allowed' })
      const computer = match ? config.computers.find(item => item.id === match[1]) : undefined
      if (match && !computer)
        return json(404, { error: 'unknown-computer' })
      if (request.headers['transfer-encoding'] !== undefined || request.headers['content-encoding'] !== undefined
        || Number(request.headers['content-length'] ?? 0) !== 0)
        return json(400, { error: 'bad-request' })
      if (action === 'computers')
        return json(200, { computers: config.computers.map(({ id, label, launcher }) => ({ id, label, hasLauncher: !!launcher })) })
      if (!computer)
        throw new Error('Missing MiniWol computer')
      if (action === 'wake' || action === 'invitation') {
        if (action === 'invitation' && !computer.launcher)
          return json(409, { error: 'no-launcher' })
        const key = `${action}/${computer.id}`
        const now = Date.now()
        const wait = Math.ceil(((cooldowns.get(key) ?? 0) - now) / 1000)
        if (wait > 0) {
          response.setHeader('Retry-After', wait)
          return json(429, { error: 'rate-limited' })
        }
        cooldowns.set(key, now + (action === 'wake' ? 3000 : 10000))
      }
      switch (action) {
        case 'launcher':
          if (!computer.launcher) return json(409, { error: 'no-launcher' })
          try {
            return json(200, await launcherStatus(computer.launcher, 'status'))
          } catch {
            return json(200, { state: 'unavailable' })
          }
        case 'wake':
          try {
            await sendWakePacket(computer.mac, config.broadcast)
            return json(202, { sent: true })
          } catch {
            return json(502, { error: 'wol-send-failed' })
          }
        case 'start':
          if (!computer.launcher) return json(409, { error: 'no-launcher' })
          try {
            const state = await callLauncher(computer.launcher, 'start')
            if (state === 'starting') return json(202, { state })
            if (state === 'ready') return json(200, { state })
            throw new Error('Invalid launcher start state')
          } catch {
            return json(502, { error: 'launcher-unavailable' })
          }
        case 'invitation':
          if (!computer.launcher) return json(409, { error: 'no-launcher' })
          return json(200, { invitationUrl: `${publicUrl.origin}/#autolauncher=${invitations.issue(computer.id, computer.launcher)}`,
            expiresInSeconds: 300 })
        default: throw new Error('Unknown MiniWol action')
      }
    }
    response.writeHead(404, { 'Content-Type': 'application/json', Connection: 'close' })
    response.end(JSON.stringify({ error: 'not-found' }))
  })
  server.requestTimeout = 5000
  server.headersTimeout = 5000
  server.timeout = 10000
  return server
}
