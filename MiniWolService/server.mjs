import { createServer } from 'node:http'
import { isIPv4 } from 'node:net'
import { readFileSync } from 'node:fs'
import { sendWakePacket } from './wol.mjs'
import { callLauncher, parseLauncher } from './launcher.mjs'
import { LauncherInvitations, readPairingToken } from './pairing.mjs'

/** @typedef {{id: string, label: string, mac: string, launcher?: import('./launcher.mjs').LauncherConfig}} Computer */
/** @typedef {{publicUrl: string, broadcast: string, computers: Computer[]}} Config */

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
    throw new Error('publicUrl must be an HTTP IPv4 origin, for example http://192.168.1.10:9009')
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

/** @param {string} value */
function escapeHtml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

/** @param {import('./launcher.mjs').LauncherState | 'unavailable'} state */
function launcherLabel(state) {
  switch (state) {
    case 'ready': return 'Jamat je připravený.'
    case 'stopped': return 'Jamat je vypnutý.'
    case 'starting': return 'Jamat se spouští. Za chvíli obnovte stav.'
    case 'failed': return 'Spuštění Jamatu selhalo. Zkontrolujte spouštěč na počítači.'
    case 'unavailable': return 'Spouštěč Jamatu není dostupný. Probuďte počítač a obnovte stav.'
    default: throw new Error('Unknown launcher state')
  }
}

/** @param {Computer} computer */
async function renderComputer(computer) {
  let launcher = ''
  if (computer.launcher) {
    /** @type {import('./launcher.mjs').LauncherState | 'unavailable'} */
    let state
    try {
      state = await callLauncher(computer.launcher, 'status')
    } catch {
      state = 'unavailable'
    }
    launcher = `<p class="launcher-status" role="status">${launcherLabel(state)}</p>
      <form method="post" action="/start/${computer.id}"><button type="submit">Spustit Jamat</button></form>
      <form method="post" action="/setup/${computer.id}"><button class="secondary" type="submit">Nastavit spouštění Jamatu</button></form>`
  }
  return `<article class="computer"><span class="pc-icon" aria-hidden="true">▣</span><h2>${escapeHtml(computer.label)}</h2>
    <form method="post" action="/wake/${computer.id}"><button type="submit">Probudit ${escapeHtml(computer.label)}</button></form>${launcher}</article>`
}

/** @param {Config} config @param {string | undefined} buildTime */
export function createWolServer(config, buildTime) {
  const publicUrl = new URL(config.publicUrl)
  const css = readFileSync(new URL('./web.css', import.meta.url))
  const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
  const invitations = new LauncherInvitations()
  let pairingRequests = 0

  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Referrer-Policy', 'same-origin')
    /** @param {number} status @param {string} message */
    const error = (status, message) => {
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
      return response.end(JSON.stringify({ version, buildTime: buildTime ?? 'dev' }))
    }
    if (request.method === 'GET' && url.pathname === '/web.css') {
      response.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' })
      return response.end(css)
    }
    if (request.method === 'GET' && url.pathname === '/') {
      const cards = (await Promise.all(config.computers.map(renderComputer))).join('')
      const sent = config.computers.find(computer => computer.id === url.searchParams.get('sent'))
      const started = config.computers.find(computer => computer.launcher && computer.id === url.searchParams.get('started'))
      const message = sent
        ? `Požadavek na probuzení ${escapeHtml(sent.label)} byl odeslán. Probuzení počítače zatím není ověřené.`
        : started ? `Požadavek na spuštění Jamatu na ${escapeHtml(started.label)} byl přijat. Aktuální stav je uvedený u počítače.`
          : 'Vyberte počítač, který chcete probudit nebo na něm spustit Jamat.'
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return response.end(`<!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>MiniWolService · Jamat</title><link rel="stylesheet" href="/web.css"></head>
        <body><main><p class="brand">JAMAT <span>WAKE-ON-LAN</span></p><h1>Probudit počítač</h1><p class="intro">Počítače v domácí síti</p>
        <p class="status${sent || started ? ' sent' : ''}" role="status">${message}</p><p><a href="/">Obnovit stav</a></p><div class="computers">${cards}</div>
        <footer>MiniWolService · ${escapeHtml(version)}</footer></main></body></html>`)
    }
    const computer = config.computers.find(item => url.pathname === `/wake/${item.id}`
      || (item.launcher && (url.pathname === `/start/${item.id}` || url.pathname === `/setup/${item.id}`)))
    if (request.method !== 'POST' || !computer || request.url !== url.pathname)
      return error(404, 'Stránka nebyla nalezena.')
    if (request.headers.origin !== publicUrl.origin)
      return error(403, 'Požadavek musí přijít z webu této služby.')
    if (request.headers['transfer-encoding'] || request.headers['content-encoding'] !== undefined
      || Number(request.headers['content-length'] ?? 0) !== 0)
      return error(400, 'Požadavek nesmí obsahovat data.')
    if (url.pathname === `/setup/${computer.id}` && computer.launcher) {
      const invitation = `${publicUrl.origin}/#autolauncher=${invitations.issue(computer.id, computer.launcher)}`
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return response.end(`<!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Nastavit spouštění Jamatu</title><link rel="stylesheet" href="/web.css"></head>
        <body><main><p class="brand">JAMAT <span>AUTOLAUNCHER</span></p><h1>Nastavit spouštění Jamatu</h1>
        <p class="intro">Počítač: ${escapeHtml(computer.label)}</p><ol class="instructions"><li>Na počítači ${escapeHtml(computer.label)} otevřete Jamat a přejděte do Nastavení → Autolauncher.</li>
        <li>Zkopírujte celou pozvánku níže a vložte ji do pole v nastavení.</li><li>Potvrďte instalaci spouštěče pro aktuální profil.</li></ol>
        <label for="invitation">Pozvánka pro ${escapeHtml(computer.label)}</label><textarea id="invitation" readonly rows="3" spellcheck="false">${escapeHtml(invitation)}</textarea>
        <p class="status" role="status">Pozvánka platí 5 minut a lze ji použít jednou, pouze na určeném počítači. Nová pozvánka zneplatní předchozí.</p>
        <p><a href="/">Zpět na počítače</a></p><footer>MiniWolService · ${escapeHtml(version)}</footer></main></body></html>`)
    }
    if (url.pathname === `/start/${computer.id}` && computer.launcher) {
      try {
        await callLauncher(computer.launcher, 'start')
        response.writeHead(303, { Location: `/?started=${computer.id}` })
        return response.end()
      } catch {
        return error(502, 'Jamat se nepodařilo spustit. Zkontrolujte, že je počítač zapnutý a jeho spouštěč dostupný, a zkuste to znovu.')
      }
    }
    try {
      await sendWakePacket(computer.mac, config.broadcast)
      console.log(`Wake packet sent: ${computer.id} -> ${config.broadcast}:9`)
      response.writeHead(303, { Location: `/?sent=${computer.id}` })
      response.end()
    } catch (cause) {
      console.error('Wake packet failed:', cause)
      error(502, 'Paket se nepodařilo odeslat. Zkuste to znovu.')
    }
  })
  server.requestTimeout = 5000
  server.headersTimeout = 5000
  server.timeout = 10000
  return server
}
