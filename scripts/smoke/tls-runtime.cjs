const { writeFileSync } = require('node:fs')
const { resolve } = require('node:path')
const https = require('node:https')

const hosts = []
for (const kind of ['dv', 'ov', 'ev'])
  for (const series of ['g3b', 'g3c'])
    for (const cross of ['', '-aaa'])
      hosts.push(`${kind}-${series}${cross}-emudhra.we-have-a-problem.com`)
const controls = ['example.com', 'github.com']
const certificateErrors = new Set([
  'CERT_REVOKED', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_UNTRUSTED', 'SELF_SIGNED_CERT_IN_CHAIN',
])
function failure(error) {
  const code = error.cause?.code ?? error.code ?? ''
  const detail = error.cause?.message ?? error.message ?? String(error)
  const rejected = certificateErrors.has(code)
    || /net::ERR_CERT_(REVOKED|AUTHORITY_INVALID)/.test(detail)
  return { outcome: rejected ? 'certificate-rejected' : 'inconclusive', code, detail }
}
function request(host, factory) {
  return new Promise(accept => {
    let settled = false
    const finish = result => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      accept(result)
    }
    const timer = setTimeout(() => {
      finish({ outcome: 'inconclusive', code: 'TIMEOUT' })
      if (req.abort) req.abort()
      else req.destroy()
    }, 12000)
    const req = factory({ protocol: 'https:', hostname: host, path: '/', method: 'GET' }, response => {
      response.on('data', () => {})
      response.on('error', error => finish(failure(error)))
      response.on('end', () => finish({ outcome: 'accepted', status: response.statusCode }))
    })
    req.on('error', error => finish(failure(error)))
    req.end()
  })
}
async function fetchHost(host) {
  try {
    const response = await fetch(`https://${host}/`, { signal: AbortSignal.timeout(12000) })
    await response.arrayBuffer()
    return { outcome: 'accepted', status: response.status }
  } catch (error) { return failure(error) }
}
async function run({ output, policy, profile, updaterPath, existingApp = false, entry = null }) {
  if (!output) throw new Error('output is required')
  if (policy) require(resolve(policy)).NodeTlsTrust.install()
  const clients = {
    https: host => request(host, (options, callback) => https.request({ ...options, agent: false }, callback)),
    fetch: fetchHost,
  }
  if (process.versions.electron && process.type === 'browser') {
    const { app, net, session } = require('electron')
    if (!existingApp) {
      if (!profile) throw new Error('profile is required for Electron')
      app.setPath('userData', resolve(profile))
    }
    await app.whenReady()
    const { ElectronHttpExecutor } = require(resolve(updaterPath))
    const updater = new ElectronHttpExecutor()
    clients.chromium = host => request(host, (options, callback) => {
      const req = net.request({ ...options, session: session.defaultSession })
      req.on('response', callback)
      return req
    })
    clients.updater = host => request(host, updater.createRequest.bind(updater))
  }
  const results = []
  for (const host of [...hosts, ...controls]) {
    const result = { host, expected: controls.includes(host) ? 'accepted' : 'certificate-rejected' }
    for (const [name, probe] of Object.entries(clients)) result[name] = await probe(host)
    results.push(result)
  }
  const passed = results.every(row => Object.keys(clients).every(name =>
    row[name].outcome === row.expected && (row.expected !== 'accepted' || row[name].status === 200)))
  const report = { at: new Date().toISOString(), executable: process.execPath, versions: process.versions,
    processType: process.type ?? 'node', policy: policy ?? null, entry, passed, results }
  writeFileSync(resolve(output), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ passed, output: resolve(output), clients: Object.keys(clients) }))
  return report
}
module.exports = { run }
if (require.main === module) {
  const args = process.argv.slice(2)
  const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined
  const finish = code => {
    if (process.type === 'browser') require('electron').app.exit(code)
    else process.exitCode = code
  }
  run({ output: option('--output'), policy: option('--policy'), profile: option('--profile'),
    updaterPath: option('--updater') }).then(report => finish(report.passed ? 0 : 1)).catch(error => {
    console.error(error)
    finish(2)
  })
}
