import { createHmac, randomBytes } from 'node:crypto'
import { request } from 'node:http'
import { isIPv4 } from 'node:net'

/** @typedef {{url: string, key: string}} LauncherConfig */
/** @typedef {'ready' | 'stopped' | 'starting' | 'failed'} LauncherState */
/** @typedef {{promise: Promise<LauncherState>, expiresAt: number}} CachedCall */
/** @type {WeakMap<LauncherConfig, {status?: CachedCall, start?: CachedCall}>} */
const calls = new WeakMap()

/** @param {unknown} value @returns {LauncherConfig} */
export function parseLauncher(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => key !== 'url' && key !== 'key')
    || !('url' in value) || typeof value.url !== 'string'
    || !('key' in value) || typeof value.key !== 'string' || !/^[0-9a-f]{64}$/i.test(value.key))
    throw new Error('Computer launcher requires url and a 64-character hexadecimal key')
  let url
  try {
    url = new URL(value.url)
  } catch {
    throw new Error('Computer launcher url must be an HTTP IPv4 origin')
  }
  if (url.protocol !== 'http:' || !isIPv4(url.hostname) || url.pathname !== '/' || url.search || url.hash || url.username || url.password)
    throw new Error('Computer launcher url must be an HTTP IPv4 origin')
  return { url: url.origin, key: value.key }
}

/** @param {unknown} value @returns {LauncherState} */
function parseState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => key !== 'state' && key !== 'error')
    || !('state' in value) || ('error' in value && typeof value.error !== 'string'))
    throw new Error('Invalid launcher response')
  switch (value.state) {
    case 'ready': return 'ready'
    case 'stopped': return 'stopped'
    case 'starting': return 'starting'
    case 'failed': return 'failed'
    default: throw new Error('Invalid launcher state')
  }
}

/** @param {LauncherConfig} config @param {'status' | 'start'} action @returns {Promise<LauncherState>} */
export function callLauncher(config, action) {
  let cache = calls.get(config)
  if (!cache) {
    cache = {}
    calls.set(config, cache)
  }
  const cached = cache[action]
  if (cached && cached.expiresAt > Date.now())
    return cached.promise
  if (action === 'start')
    delete cache.status
  const pending = { promise: requestLauncher(config, action), expiresAt: Infinity }
  cache[action] = pending
  pending.promise = pending.promise.finally(() => {
    pending.expiresAt = Date.now() + 1000
    if (action === 'start')
      delete cache.status
  })
  return pending.promise
}

/** @param {LauncherConfig} config @param {'status' | 'start'} action @returns {Promise<LauncherState>} */
function requestLauncher(config, action) {
  let method
  let pathname
  if (action === 'status') {
    method = 'GET'
    pathname = '/api/status'
  } else if (action === 'start') {
    method = 'POST'
    pathname = '/api/start'
  } else throw new Error('Unknown launcher action')
  const timestamp = String(Date.now())
  const nonce = randomBytes(16).toString('hex')
  const signature = createHmac('sha256', Buffer.from(config.key, 'hex'))
    .update(`${method}\n${pathname}\n${timestamp}\n${nonce}`).digest('hex')
  return new Promise((resolve, reject) => {
    const req = request(new URL(pathname, config.url), {
      method, agent: false, signal: AbortSignal.timeout(3000),
      headers: { 'X-Jamat-Timestamp': timestamp, 'X-Jamat-Nonce': nonce, 'X-Jamat-Signature': signature },
    }, response => {
      if ((action === 'status' && response.statusCode !== 200)
        || (action === 'start' && response.statusCode !== 200 && response.statusCode !== 202)
        || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers['content-type'] ?? '')
        || response.headers['content-encoding']) {
        response.destroy()
        return reject(new Error('Invalid launcher response'))
      }
      /** @type {Buffer[]} */
      const chunks = []
      let length = 0
      response.on('error', reject)
      response.on('data', chunk => {
        length += chunk.length
        if (length > 16 * 1024) {
          response.destroy()
          return reject(new Error('Launcher response exceeds limit'))
        }
        chunks.push(chunk)
      })
      response.on('end', () => {
        try {
          const state = parseState(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))))
          if (action === 'start' && !((response.statusCode === 200 && state === 'ready') || (response.statusCode === 202 && state === 'starting')))
            throw new Error('Invalid launcher start response')
          resolve(state)
        } catch {
          reject(new Error('Invalid launcher response'))
        }
      })
    })
    req.on('error', reject)
    req.end()
  })
}
