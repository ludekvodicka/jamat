import { useEffect, useRef, useState, useCallback } from 'react'
import type {
  RemoteControlData,
  RemotePeer,
  RemoteWindowInfo,
  PeerReachability,
  OpenTabReq,
} from '../../../../../core/types/remote-control'
import { CONTROL_PORT_PACKAGED, DEFAULT_AGENT_PORT, CONTROL_PORT_MIN, CONTROL_PORT_MAX, isValidControlPort } from '../../../../../core/types/remote-control'
import { useLayoutStore } from '../../store/layout-store'
import { openOrActivatePanel, openPeerFile as sharedOpenPeerFile, openPeerChanges as sharedOpenPeerChanges, openPeerNotes as sharedOpenPeerNotes } from '../../utils/terminal-helpers'

type Status = PeerReachability | 'probing'

const STATUS_COLOR: Record<Status, string> = {
  'app-up': '#3fb950',
  'agent-only': '#d29922',
  unauthorized: '#f85149',
  offline: '#6e7681',
  probing: '#444',
}
const STATUS_LABEL: Record<Status, string> = {
  'app-up': 'app online',
  'agent-only': 'agent only (app closed)',
  unauthorized: 'invalid token',
  offline: 'offline',
  probing: 'probing…',
}

const box: React.CSSProperties = { border: '1px solid #2a2a2a', borderRadius: 6, padding: 12, marginBottom: 12 }
const label: React.CSSProperties = { fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5 }
const input: React.CSSProperties = { background: '#1e1e1e', color: '#ddd', border: '1px solid #333', borderRadius: 4, padding: '3px 6px', fontSize: 12 }
const btn: React.CSSProperties = { background: '#0e639c', color: '#fff', border: 'none', borderRadius: 4, padding: '4px 10px', fontSize: 12, cursor: 'pointer' }
const btnGhost: React.CSSProperties = { ...btn, background: '#2a2a2a' }
const TREE_REFRESH_SEC = 5

export function RemoteConnectionsPanel() {
  const [config, setConfig] = useState<RemoteControlData | null>(null)
  const [serverInfo, setServerInfo] = useState<{ hostname: string; ips: string[] } | null>(null)
  const [revealToken, setRevealToken] = useState(false)
  const [status, setStatus] = useState<Record<string, Status>>({})
  const [versions, setVersions] = useState<Record<string, string>>({}) // peer id → app version, from the health probe
  const [bindState, setBindState] = useState<{ enabled: boolean; bound: boolean; port: number } | null>(null) // runtime LAN-listener bind state
  const [compat, setCompat] = useState<Record<string, boolean>>({}) // peer id → wire-protocol compatible (false = incompatible/legacy build)
  const [selectedPeerId, setSelectedPeerId] = useState<string | null>(null)
  const [windows, setWindows] = useState<RemoteWindowInfo[] | null>(null)
  const [windowsError, setWindowsError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [refreshIn, setRefreshIn] = useState(TREE_REFRESH_SEC)
  const [debugBusy, setDebugBusy] = useState<string | null>(null) // which peer-debug action is in flight
  const [debugOut, setDebugOut] = useState<string | null>(null)   // logs/terminals output for the open peer
  const loadReqRef = useRef(0) // request token: drop a stale loadWindows result on peer switch

  const peers = config?.peers ?? []
  const selectedPeer = peers.find((p) => p.id === selectedPeerId) ?? null
  const selectedStatus = selectedPeer ? status[selectedPeer.id] : undefined
  // The auto-probe interval reads peers through this ref (kept current every render) so a token /
  // host / port edit is picked up on the NEXT tick. Without it, the interval's `run` closes over the
  // pre-edit peers (its effect key omits the token), and a few seconds after a manual refresh a tick
  // re-probes with the STALE token — reverting the status to what it was before the edit.
  const peersRef = useRef(peers)
  peersRef.current = peers

  useEffect(() => { window.electronAPI?.getRemoteConfig?.().then(setConfig) }, [])
  // Poll the runtime bind state so the status reflects an actual EADDRINUSE bind failure
  // instead of optimistically claiming "listening" just because the config says enabled.
  useEffect(() => {
    const refresh = () => window.electronAPI?.getRemoteBindState?.().then(setBindState)
    refresh()
    const t = setInterval(refresh, 5000)
    return () => clearInterval(t)
  }, [])
  useEffect(() => { window.electronAPI?.getLocalIps?.().then(setServerInfo) }, [])
  // Drop any debug output when the open peer changes (it belonged to the previous peer).
  useEffect(() => { setDebugOut(null) }, [selectedPeerId])

  // Drive a peer's debug op over its reach-gated /op endpoint. `isAction` ops (restart/
  // fullrestart) confirm first and report via the notice; reads (logs/terminals) dump
  // their JSON into the collapsible output area.
  const runPeerDebug = useCallback(async (peer: RemotePeer, name: string, action: string, isAction: boolean) => {
    if (isAction && !window.confirm(`${action} the remote app on "${peer.name || peer.host}"? This affects the running peer.`)) return
    setNotice(null); setDebugBusy(action)
    try {
      const r = await window.electronAPI?.remoteOp?.(peer, name)
      if (!r?.ok) { setNotice(`${action} failed: ${r?.error ?? 'error'}`); return }
      if (isAction) setNotice(`${action} → ${String((r.data as { action?: string })?.action ?? 'ok')}`)
      else { const s = JSON.stringify(r.data, null, 2); setDebugOut(s.length > 8000 ? `${s.slice(0, 8000)}\n…(truncated)` : s) }
    } finally { setDebugBusy(null) }
  }, [])

  const save = useCallback(async (next: RemoteControlData) => {
    setConfig(next)
    await window.electronAPI?.saveRemoteConfig?.(next)
  }, [])

  const persist = useCallback(() => { setConfig((c) => { if (c) window.electronAPI?.saveRemoteConfig?.(c); return c }) }, [])

  // Probe ONE peer: flip it to "probing" (only when explicitly requested, so the 5s loop
  // doesn't flicker a known status every cycle) then write back reachability/version/compat.
  // Shared by the auto-probe loop AND the manual "Re-check" button — an immediate re-check
  // without waiting out the interval, handy after fixing a peer that shows offline.
  const probePeer = useCallback((p: RemotePeer, showProbing = false) => {
    setStatus((s) => ({ ...s, [p.id]: showProbing ? 'probing' : (s[p.id] ?? 'probing') }))
    window.electronAPI?.remoteProbe?.(p).then((r) => {
      if (!r) return
      setStatus((s) => ({ ...s, [p.id]: r.reachability }))
      if (r.version) { const v = r.version; setVersions((m) => ({ ...m, [p.id]: v })) }
      setCompat((m) => ({ ...m, [p.id]: r.compatible !== false }))
    }).catch(() => {})
  }, [])

  // Probe every peer on a 5s interval. `run` reads `peersRef.current` (not the captured `peers`) so
  // an edited token is used immediately — see the peersRef note above.
  useEffect(() => {
    if (peers.length === 0) return
    const run = () => { for (const p of peersRef.current) probePeer(p) }
    run()
    const t = setInterval(run, 5000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peers.map((p) => p.id + p.host + p.controlPort + p.agentPort).join('|')])

  // `quiet` (auto-refresh) updates the tree in place without flashing it to a
  // "Loading…" state or surfacing a transient error.
  const loadWindows = useCallback(async (p: RemotePeer, quiet = false) => {
    const myReq = ++loadReqRef.current
    if (!quiet) { setWindows(null); setWindowsError(null) }
    const r = await window.electronAPI?.remoteWindows?.(p)
    if (loadReqRef.current !== myReq) return // a newer load (e.g. peer switch) superseded this
    if (!r) { if (!quiet) setWindowsError('no response'); return }
    if (r.ok) { setWindows(r.windows ?? []); setWindowsError(null) }
    else if (!quiet) setWindowsError(r.error ?? 'error')
  }, [])

  // Load the windows tree when an app-up peer is selected.
  useEffect(() => {
    if (selectedPeer && selectedStatus === 'app-up') loadWindows(selectedPeer)
    else setWindows(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPeerId, selectedStatus])

  // Auto-refresh the windows/tabs tree every TREE_REFRESH_SEC while an app-up peer
  // is open, with a 1s countdown shown next to Refresh. Quiet refresh = no flicker.
  useEffect(() => {
    if (!selectedPeer || selectedStatus !== 'app-up') return
    const peer = selectedPeer
    setRefreshIn(TREE_REFRESH_SEC)
    const t = setInterval(() => {
      setRefreshIn((n) => {
        if (n <= 1) { loadWindows(peer, true); return TREE_REFRESH_SEC }
        return n - 1
      })
    }, 1000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPeerId, selectedStatus, loadWindows])

  const launchPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [launching, setLaunching] = useState(false)

  // Clear any in-flight launch poll on unmount.
  useEffect(() => () => { if (launchPollRef.current) clearInterval(launchPollRef.current) }, [])

  // Open the selected tab's live terminal in its OWN dockview tab (full window),
  // not crammed inside this panel. One viewer per peer+terminal (re-click just
  // re-activates it). RemoteViewerPanel is intentionally NOT in the tab picker —
  // it can only be opened from here, because it needs the {peer, terminalId} param.
  const openViewer = useCallback((peer: RemotePeer, terminalId: string, title: string) => {
    const api = useLayoutStore.getState().dockviewApi
    if (!api) { setNotice('No window available to open the viewer'); return }
    openOrActivatePanel(api, `remote-view:${peer.id}:${terminalId}`, 'remoteViewerPanel', `🛰 ${peer.name}: ${title}`, { peer, terminalId })
  }, [])

  // Open a PEER's file in a read-only FileViewer here (Direction #2) — shared opener so the live
  // viewer opens the exact same panel. The viewer reads the file + diff baselines over the op API
  // (path-scoped to the peer's project roots server-side); `projectDir` unlocks session diff modes.
  const openPeerFile = useCallback((peer: RemotePeer, filePath: string, projectDir?: string) => {
    const api = useLayoutStore.getState().dockviewApi
    if (!api) { setNotice('No window available to open the file'); return }
    sharedOpenPeerFile(api, peer, filePath, projectDir)
  }, [])

  // Open a PEER's session File-Changes panel here (Direction #2). projectDir = the peer tab's cwd;
  // sessionId pins the diff to that tab's session. The panel reads everything over the op API.
  const openPeerChanges = useCallback((peer: RemotePeer, projectDir: string, sessionId: string | undefined, title: string) => {
    const api = useLayoutStore.getState().dockviewApi
    if (!api) { setNotice('No window available to open the panel'); return }
    sharedOpenPeerChanges(api, peer, projectDir, sessionId, title)
  }, [])

  // Open a PEER's notes (keyed by project dir == the peer tab's cwd) here — read+write over the op API.
  const openPeerNotes = useCallback((peer: RemotePeer, projectDir: string, title: string) => {
    const api = useLayoutStore.getState().dockviewApi
    if (!api) { setNotice('No window available to open the panel'); return }
    sharedOpenPeerNotes(api, peer, projectDir, title)
  }, [])

  // Open a PEER WINDOW's ideas here (ideas are per-window, not per-project) — read+write over the op API.
  const openPeerIdeas = useCallback((peer: RemotePeer, windowId: number, title: string) => {
    const api = useLayoutStore.getState().dockviewApi
    if (!api) { setNotice('No window available to open the panel'); return }
    openOrActivatePanel(api, `remote-ideas:${peer.id}:${windowId}`, 'ideasPanel', `🛰 ${peer.name}: 💡 ${title}`, { peer, windowId: String(windowId) })
  }, [])

  // ── peer editing ─────────────────────────────────────────────────────────
  const updatePeer = (id: string, patch: Partial<RemotePeer>) =>
    setConfig((c) => (c ? { ...c, peers: c.peers.map((p) => (p.id === id ? { ...p, ...patch } : p)) } : c))

  const addPeer = () => {
    if (!config) return
    const p: RemotePeer = { id: crypto.randomUUID(), name: 'New peer', host: '', controlPort: CONTROL_PORT_PACKAGED, agentPort: DEFAULT_AGENT_PORT, token: '' }
    save({ ...config, peers: [...config.peers, p] })
  }
  const removePeer = (id: string) => { if (config) save({ ...config, peers: config.peers.filter((p) => p.id !== id) }) }
  const toggleEnabled = () => { if (config) save({ ...config, enabled: !config.enabled }) }

  // ── launch / open-tab ───────────────────────────────────────────────────
  const [ot, setOt] = useState<{ tabType: 'claude' | 'cmd' | 'powershell'; command: string; windowId?: number; activate: boolean }>(
    { tabType: 'claude', command: '', activate: true })
  const [viewPath, setViewPath] = useState('') // path for the per-peer "View a file" box

  // Open a tab on the peer (req carries a suggested terminalId), then discover the
  // newly-appeared *streamable* tab and open its viewer here. We suggest an id (newer
  // peers honor it), but we DON'T rely on it: discovering the real id works across peer
  // versions AND means the viewer subscribes to a PTY that already exists — no blank
  // "stream ended" from racing a not-yet-spawned terminal. Shared by "Open a new tab"
  // and the per-session "fork".
  const openTabAndView = useCallback(async (peer: RemotePeer, req: OpenTabReq, fallbackTitle: string) => {
    const before = new Set<string>()
    for (const w of (windows ?? [])) for (const t of w.tabs) if (t.streamable) before.add(t.terminalId)
    const r = await window.electronAPI?.remoteOpenTab?.(peer, req)
    if (!r?.ok) { setNotice(`Open-tab failed: ${r?.error ?? 'error'}`); return }
    setNotice('Opening the tab on the peer…')

    let tries = 0
    const discover = async () => {
      tries++
      const wr = await window.electronAPI?.remoteWindows?.(peer)
      if (wr?.ok && wr.windows) {
        setWindows(wr.windows)
        let target: string | undefined
        let title: string | undefined
        for (const w of wr.windows) for (const t of w.tabs) {
          if (!t.streamable) continue
          if (t.terminalId === req.terminalId) { target = req.terminalId; title = t.title }       // peer honored our id
          else if (!before.has(t.terminalId) && !target) { target = t.terminalId; title = t.title } // any new streamable tab
        }
        if (target) {
          openViewer(peer, target, title || fallbackTitle)
          setNotice('Controlling the new tab')
          return
        }
      }
      if (tries < 14) setTimeout(discover, 700)
      else setNotice('Opened on the peer, but no new viewable tab appeared — check the peer (and that it has Node for a Jamat menu).')
    }
    setTimeout(discover, 500)
  }, [windows, openViewer])

  const openTab = async () => {
    if (!selectedPeer) return
    // A Claude tab lands on the project menu; drive it live with ↑/↓/Enter.
    await openTabAndView(selectedPeer, {
      tabType: ot.tabType,
      command: ot.tabType !== 'claude' && ot.command ? ot.command : undefined,
      terminalId: `remote-${ot.tabType}-${crypto.randomUUID()}`,
      windowId: ot.windowId,
      activate: ot.activate,
    }, ot.tabType === 'claude' ? 'Claude (new)' : ot.tabType.toUpperCase())
  }

  // Fork a peer's running Claude session into a NEW tab on the peer (history kept, new
  // session id) and open its viewer here, so it can be driven separately from the original.
  // The peer re-resolves the session id + cwd server-side from `forkOf` (never the wire).
  const forkRemoteSession = useCallback((peer: RemotePeer, terminalId: string, title: string) => {
    void openTabAndView(peer, {
      tabType: 'claude',
      forkOf: terminalId,
      terminalId: `remote-fork-${crypto.randomUUID()}`,
      label: `${title} (fork)`,
      activate: ot.activate,
    }, `${title} (fork)`)
  }, [openTabAndView, ot.activate])

  const launchApp = async () => {
    if (!selectedPeer || launching) return
    const peer = selectedPeer
    if (launchPollRef.current) { clearInterval(launchPollRef.current); launchPollRef.current = null }
    setLaunching(true)
    setNotice('Launching… this can take up to a minute on first run')
    const r = await window.electronAPI?.remoteLaunchApp?.(peer)
    if (!r?.ok) { setLaunching(false); setNotice(`Launch failed: ${r?.error ?? 'error'}`); return }
    let tries = 0
    const stop = () => { if (launchPollRef.current) { clearInterval(launchPollRef.current); launchPollRef.current = null } setLaunching(false) }
    launchPollRef.current = setInterval(async () => {
      tries++
      const pr = await window.electronAPI?.remoteProbe?.(peer).catch(() => null)
      if (pr?.reachability === 'app-up') {
        stop()
        setStatus((s) => ({ ...s, [peer.id]: 'app-up' }))
        setNotice('App is up')
        loadWindows(peer)
      } else if (tries > 30) {
        stop()
        setNotice('Timed out waiting for the app to come up')
      }
    }, 3000)
  }

  if (!config) return <div style={{ padding: 16, color: '#888' }}>Loading…</div>

  const tokenDisplay = revealToken ? config.token : '•'.repeat(Math.min((config.token ?? '').length, 16))
  // 24 bytes = 48 hex chars, comfortably above MIN_TOKEN_LEN (mirrors the main
  // process `genToken`). save() re-sanitizes, regenerating anything weaker.
  const genHex = (bytes = 24): string => {
    const a = new Uint8Array(bytes); crypto.getRandomValues(a)
    return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('')
  }
  const rotateToken = () => { save({ ...config, token: genHex() }); setRevealToken(true); setNotice('Token rotated — re-share it with every peer that connects') }

  return (
    <div style={{ padding: 14, overflowY: 'auto', height: '100%', color: '#ddd', fontFamily: 'system-ui, sans-serif' }}>
      {/* ── This machine (server) ── */}
      <div style={box}>
        <div style={{ ...label, marginBottom: 8 }}>This machine (server)</div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <input type="checkbox" checked={config.enabled} onChange={toggleEnabled} />
          <span>Allow remote control{config.enabled ? '' : ' (off — nothing is exposed)'}</span>
          {(() => {
            const bindFailed = config.enabled && !!bindState && bindState.enabled && !bindState.bound
            return (
              <span
                title={bindFailed
                  ? `Enabled but the LAN listener failed to bind port ${config.listenPort} — likely already in use by another process/instance.`
                  : `Control port ${config.listenPort} (47200 packaged, 47201 dev). This is the port a peer enters as "ctrl port".`}
                style={{ marginLeft: 'auto', fontSize: 11, color: !config.enabled ? '#6e7681' : (bindFailed ? '#f85149' : '#3fb950') }}
              >
                {!config.enabled ? 'stopped' : bindFailed ? `failed to bind :${config.listenPort} (in use?)` : `listening on port ${config.listenPort}`}
              </span>
            )
          })()}
        </label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginBottom: 8 }}>
          <span style={{ color: '#888' }}>Listen port:</span>
          <input
            style={{ ...input, width: 90 }}
            type="number"
            min={CONTROL_PORT_MIN}
            max={CONTROL_PORT_MAX}
            title="This machine's control-server port (default 47200; 47201 dev). Change it to run a second instance on the same machine — each instance needs its own port. Peers must use the new port as 'ctrl port'."
            value={config.listenPort}
            onChange={(e) => setConfig((c) => (c ? { ...c, listenPort: Number(e.target.value) } : c))}
            onBlur={persist}
          />
          <span style={{ fontSize: 11, color: isValidControlPort(config.listenPort) ? '#666' : '#f85149' }}>
            {isValidControlPort(config.listenPort)
              ? 'default 47200 — change to run multiple instances on one machine'
              : `must be ${CONTROL_PORT_MIN}–${CONTROL_PORT_MAX}`}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
          <span style={{ color: '#888' }}>Token:</span>
          <code style={{ background: '#1e1e1e', padding: '2px 6px', borderRadius: 4, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tokenDisplay}</code>
          <button style={btnGhost} onClick={() => setRevealToken((v) => !v)}>{revealToken ? 'Hide' : 'Reveal'}</button>
          <button style={btnGhost} onClick={() => { navigator.clipboard.writeText(config.token ?? ''); setNotice('Token copied') }}>Copy</button>
          <button style={btnGhost} onClick={rotateToken} title="Generate a new machine token (revokes the old one — peers must re-paste it)">Rotate</button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, marginTop: 6, flexWrap: 'wrap' }}>
          <span style={{ color: '#888' }}>This PC:</span>
          {serverInfo && serverInfo.ips.length > 0 ? serverInfo.ips.map((ip) => (
            <code
              key={ip}
              title="Click to copy host:port"
              style={{ background: '#1e1e1e', padding: '2px 6px', borderRadius: 4, cursor: 'pointer' }}
              onClick={() => { navigator.clipboard.writeText(`${ip}:${config.listenPort}`); setNotice(`Copied ${ip}:${config.listenPort}`) }}
            >
              {ip}:{config.listenPort}
            </code>
          )) : <span style={{ color: '#666' }}>no LAN IP detected</span>}
          {serverInfo?.hostname && <span style={{ color: '#666' }}>({serverInfo.hostname})</span>}
        </div>
        <div style={{ fontSize: 11, color: '#666', marginTop: 6 }}>
          Give another machine one of these addresses + the token above to let it connect.
        </div>
      </div>

      {/* ── Peers ── */}
      <div style={{ ...label, display: 'flex', alignItems: 'center', marginBottom: 6 }}>
        <span>Remote connections</span>
        <button style={{ ...btnGhost, marginLeft: 'auto' }} onClick={addPeer}>+ Add</button>
      </div>
      <div style={{ fontSize: 11, color: '#666', marginBottom: 8, lineHeight: 1.5 }}>
        <b>ctrl port</b> = the peer app's control surface (default <b>47200</b>; a dev build uses 47201) — used to view &amp; drive its tabs.{' '}
        <b>agent port</b> = the peer's always-on agent (default <b>3501</b>) — only needed to launch the app when it's closed; leave default if unused.
      </div>
      {peers.length === 0 && <div style={{ color: '#666', fontSize: 12, marginBottom: 12 }}>No peers yet. Add one above.</div>}
      {peers.map((p) => {
        const st = status[p.id] ?? 'probing'
        const incompat = st === 'app-up' && compat[p.id] === false
        const selected = p.id === selectedPeerId
        return (
          <div key={p.id} style={{ ...box, borderColor: selected ? '#0e639c' : '#2a2a2a' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span title={incompat ? 'non-compatible version' : STATUS_LABEL[st]} style={{ width: 9, height: 9, borderRadius: '50%', background: incompat ? '#f85149' : STATUS_COLOR[st], display: 'inline-block' }} />
              <input style={{ ...input, fontWeight: 600 }} value={p.name} onChange={(e) => updatePeer(p.id, { name: e.target.value })} onBlur={persist} />
              {incompat
                ? <span style={{ fontSize: 11, color: '#f85149', fontWeight: 600 }}>non-compatible version</span>
                : <span style={{ fontSize: 11, color: '#888' }}>{STATUS_LABEL[st]}</span>}
              {versions[p.id] && <span title="Peer app version" style={{ fontSize: 10, color: '#666', fontFamily: 'monospace' }}>v{versions[p.id]}</span>}
              <button style={{ ...btnGhost, marginLeft: 'auto', padding: '4px 8px' }} title="Re-check this peer's status now (don't wait for the 5s auto-probe)" onClick={() => probePeer(p, true)}>↻</button>
              <button style={btnGhost} onClick={() => setSelectedPeerId(selected ? null : p.id)}>{selected ? 'Hide' : 'Open'}</button>
              <button style={{ ...btnGhost, background: '#5a1d1d' }} onClick={() => removePeer(p.id)}>✕</button>
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <input style={{ ...input, width: 150 }} placeholder="host / IP" value={p.host} onChange={(e) => updatePeer(p.id, { host: e.target.value })} onBlur={persist} />
              <input style={{ ...input, width: 90 }} placeholder="ctrl port" type="number" title="The peer app's control port (default 47200; 47201 for a dev build)" value={p.controlPort} onChange={(e) => updatePeer(p.id, { controlPort: Number(e.target.value) })} onBlur={persist} />
              <input style={{ ...input, width: 90 }} placeholder="agent port" type="number" title="The peer's always-on agent port (default 3501) — only used to launch the app when it's closed" value={p.agentPort} onChange={(e) => updatePeer(p.id, { agentPort: Number(e.target.value) })} onBlur={persist} />
              <input style={{ ...input, flex: 1, minWidth: 160 }} placeholder="token" type="password" value={p.token} onChange={(e) => updatePeer(p.id, { token: e.target.value })} onBlur={persist} />
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
              <input style={{ ...input, width: 150 }} placeholder="MAC (wake, optional)" title="Peer MAC for Wake-on-LAN, e.g. AA:BB:CC:DD:EE:FF" value={p.mac ?? ''} onChange={(e) => updatePeer(p.id, { mac: e.target.value })} onBlur={persist} />
              <input style={{ ...input, width: 190 }} placeholder="WoL proxy URL (optional)" title="app-wol proxy on the peer's LAN, e.g. http://<host>:9009" value={p.wolProxyUrl ?? ''} onChange={(e) => updatePeer(p.id, { wolProxyUrl: e.target.value })} onBlur={persist} />
            </div>

            {selected && (
              <div style={{ marginTop: 10 }}>
                {st === 'agent-only' && (
                  <button style={btn} onClick={launchApp} disabled={launching}>{launching ? 'Launching…' : 'Launch app remotely'}</button>
                )}
                {st === 'offline' && (
                  <div style={{ color: '#888', fontSize: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span>Peer unreachable. Check host/port/firewall and that remote control is enabled there.</span>
                    <button style={{ ...btnGhost, flexShrink: 0 }} onClick={() => probePeer(p, true)}>↻ Re-check</button>
                  </div>
                )}
                {st === 'unauthorized' && (
                  <div style={{ color: '#f85149', fontSize: 12, lineHeight: 1.5 }}>
                    <b>Invalid token.</b> The peer’s app is running but rejected this token. Reveal the peer’s
                    token in <i>its</i> Remote connection settings and paste it into the <b>token</b> field above
                    exactly (it’s the peer’s machine key, not yours). If the token is right, check the peer allows
                    this host.
                    <button style={{ ...btnGhost, flexShrink: 0, marginLeft: 8 }} onClick={() => probePeer(p, true)}>↻ Re-check</button>
                  </div>
                )}
                {incompat && (
                  <div style={{ color: '#f85149', fontSize: 12, lineHeight: 1.5 }}>
                    <b>Non-compatible version.</b> This peer answers but runs an incompatible remote-control protocol
                    {versions[p.id] ? ` (build v${versions[p.id]})` : ''} — most likely an older Jamat build.
                    Update it to a matching build to view &amp; drive its tabs.
                  </div>
                )}
                {st === 'app-up' && !incompat && (
                  <>
                    <div style={{ ...label, marginBottom: 4, display: 'flex', alignItems: 'center' }}>
                      <span>Windows &amp; tabs</span>
                      <span style={{ marginLeft: 'auto', fontSize: 11, color: '#666' }}>auto {refreshIn}s</span>
                      <button style={{ ...btnGhost, marginLeft: 6 }} onClick={() => { loadWindows(p); setRefreshIn(TREE_REFRESH_SEC) }}>Refresh</button>
                    </div>
                    <div style={{ fontSize: 11, color: '#666', marginBottom: 4 }}>Click a terminal tab → opens its live viewer. <b>fork ⎇</b> on a Claude session → forks it into a new tab on the peer (new id, history kept) and opens that.</div>
                    {windowsError && <div style={{ color: '#d29922', fontSize: 12 }}>{windowsError}</div>}
                    {windows === null && !windowsError && <div style={{ color: '#666', fontSize: 12 }}>Loading tabs…</div>}
                    {windows?.length === 0 && <div style={{ color: '#666', fontSize: 12 }}>No windows reported.</div>}
                    {windows?.map((w) => (
                      <div key={w.windowId} style={{ marginBottom: 6 }}>
                        <div style={{ fontSize: 12, color: '#aaa', margin: '4px 0', display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span>🗔 {w.title}</span>
                          <button
                            onClick={() => openPeerIdeas(p, w.windowId, w.title || `window ${w.windowId}`)}
                            title="Open this window's ideas here (read + write, read from the peer). Ideas are per-window, not per-project."
                            style={{ fontSize: 10, color: '#d6b36c', background: 'none', border: '1px solid #443', borderRadius: 3, padding: '0 5px', cursor: 'pointer' }}
                          >💡 ideas</button>
                        </div>
                        {w.tabs.map((t) => {
                          // AI-managed tab — opened automatically by the Jamat / a remote AI (its
                          // terminalId is `ai-…`). Mirror CustomTab's 🤖 + violet treatment so a human spots
                          // auto-opened AI sessions here in the remote tree too, not just on the local machine.
                          const isAi = t.terminalId.startsWith('ai-')
                          return (
                          <div
                            key={t.terminalId}
                            onClick={() => { if (t.streamable) openViewer(p, t.terminalId, t.title) }}
                            title={isAi ? 'AI-managed tab — opened automatically by the Jamat (auto-closed when done)' : (t.streamable ? 'Open this tab in its own viewer window' : 'Not a streamable terminal')}
                            style={{
                              display: 'flex', alignItems: 'center', gap: 6, padding: '3px 8px', marginLeft: 12,
                              borderRadius: 4, fontSize: 12,
                              cursor: t.streamable ? 'pointer' : 'default',
                              opacity: t.streamable ? 1 : 0.5,
                              ...(isAi ? { background: 'rgba(139, 92, 246, 0.18)', borderLeft: '2px solid #9370db', paddingLeft: 6 } : null),
                            }}
                          >
                            {isAi && <span aria-hidden="true" title="AI-managed tab" style={{ fontSize: 11, lineHeight: 1, flexShrink: 0 }}>🤖</span>}
                            <span>{t.type === 'terminal' ? '›' : '#'}</span>
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}>{t.title}</span>
                            {t.streamable && <span style={{ fontSize: 10, color: '#0e639c', border: '1px solid #244', borderRadius: 3, padding: '0 5px' }}>open ▸</span>}
                            {/* Forkable only for running Claude sessions (sessionId present). Stop
                                propagation so the click forks instead of opening the parent's viewer. */}
                            {t.sessionId && (
                              <button
                                onClick={(e) => { e.stopPropagation(); forkRemoteSession(p, t.terminalId, t.title) }}
                                title="Fork this session into a new tab on the peer (new session id, history kept) and open its viewer here — work on it separately from the original"
                                style={{ fontSize: 10, color: '#b083f0', background: 'none', border: '1px solid #3a2a55', borderRadius: 3, padding: '0 5px', cursor: 'pointer' }}
                              >
                                fork ⎇
                              </button>
                            )}
                            {/* Open this tab's session File-Changes + Notes here (peer-backed). */}
                            {t.cwd && (
                              <>
                                <button
                                  onClick={(e) => { e.stopPropagation(); openPeerChanges(p, t.cwd!, t.sessionId, t.title) }}
                                  title="Open this session's modified files + diffs here (read-only, read from the peer)"
                                  style={{ fontSize: 10, color: '#6cb6ff', background: 'none', border: '1px solid #244', borderRadius: 3, padding: '0 5px', cursor: 'pointer' }}
                                >
                                  📝 changes
                                </button>
                                <button
                                  onClick={(e) => { e.stopPropagation(); openPeerNotes(p, t.cwd!, t.title) }}
                                  title="Open this project's notes here (read + write, stored on the peer)"
                                  style={{ fontSize: 10, color: '#7fd6a0', background: 'none', border: '1px solid #243', borderRadius: 3, padding: '0 5px', cursor: 'pointer' }}
                                >
                                  🗒 notes
                                </button>
                              </>
                            )}
                            {t.status && t.status !== 'idle' && <span style={{ fontSize: 10, color: '#d29922' }}>{t.status}</span>}
                            <span style={{ flex: 1 }} />
                          </div>
                          )
                        })}
                      </div>
                    ))}

                    {/* debug / control — drives the peer's reach-gated debug ops */}
                    <div style={{ ...box, marginTop: 10, marginBottom: 10 }}>
                      <div style={{ ...label, marginBottom: 6 }}>Debug / control</div>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                        <button style={btnGhost} disabled={!!debugBusy} onClick={() => runPeerDebug(p, 'debug:logs', 'Logs', false)}>Logs</button>
                        <button style={btnGhost} disabled={!!debugBusy} onClick={() => runPeerDebug(p, 'debug:terminals', 'Terminals', false)}>Terminals</button>
                        <button style={{ ...btnGhost, background: '#5a3d1d' }} disabled={!!debugBusy} onClick={() => runPeerDebug(p, 'debug:restart', 'Restart', true)} title="Recreate the peer's windows in-process">Restart</button>
                        <button style={{ ...btnGhost, background: '#5a1d1d' }} disabled={!!debugBusy} onClick={() => runPeerDebug(p, 'debug:fullrestart', 'Full-restart', true)} title="Relaunch the peer's whole process (reloads main code too)">Full-restart</button>
                        {debugBusy && <span style={{ fontSize: 11, color: '#888' }}>{debugBusy}…</span>}
                      </div>
                      {debugOut && (
                        <div style={{ marginTop: 6 }}>
                          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 2 }}>
                            <span style={{ fontSize: 11, color: '#666' }}>output</span>
                            <button style={{ ...btnGhost, marginLeft: 'auto', padding: '0 8px' }} onClick={() => setDebugOut(null)}>✕</button>
                          </div>
                          <pre style={{ background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: 4, padding: 8, fontSize: 11, maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0 }}>{debugOut}</pre>
                        </div>
                      )}
                      <div style={{ fontSize: 11, color: '#666', marginTop: 6 }}>Drives the peer&apos;s debug ops over the gated /op endpoint. Restart / Full-restart affect the running remote app.</div>
                    </div>

                    {/* open-tab form */}
                    <div style={{ ...box, marginTop: 10, marginBottom: 0 }}>
                      <div style={{ ...label, marginBottom: 6 }}>Open a new tab</div>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                        <select style={input} value={ot.tabType} onChange={(e) => setOt({ ...ot, tabType: e.target.value as 'claude' | 'cmd' | 'powershell' })}>
                          <option value="claude">Claude (project menu)</option>
                          <option value="cmd">CMD</option>
                          <option value="powershell">PowerShell</option>
                        </select>
                        <select style={input} title="Which remote window to open the tab in" value={ot.windowId ?? ''} onChange={(e) => setOt({ ...ot, windowId: e.target.value ? Number(e.target.value) : undefined })}>
                          <option value="">active window</option>
                          {(windows ?? []).map((w) => <option key={w.windowId} value={w.windowId}>{w.title || `window ${w.windowId}`}</option>)}
                        </select>
                        {ot.tabType !== 'claude' && (
                          <input style={{ ...input, flex: 1, minWidth: 140 }} placeholder="initial command (optional)" value={ot.command} onChange={(e) => setOt({ ...ot, command: e.target.value })} />
                        )}
                        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#bbb', cursor: 'pointer', whiteSpace: 'nowrap' }} title="Focus the new tab on the remote machine. Off = open it silently, leaving the tab that's active there active (also applies to fork ⎇).">
                          <input type="checkbox" checked={ot.activate} onChange={(e) => setOt({ ...ot, activate: e.target.checked })} />
                          Activate on remote
                        </label>
                        <button style={btn} onClick={openTab}>Open</button>
                      </div>
                      <div style={{ fontSize: 11, color: '#666', marginTop: 6 }}>
                        {ot.tabType === 'claude'
                          ? 'Opens the peer’s project selector menu AND a viewer tab here — pick a project live with ↑ ↓ + Enter.'
                          : 'Opens a shell on the peer AND a viewer tab here; the optional command runs once it’s ready.'}
                      </div>
                    </div>

                    {/* view a peer file (read-only) — opens a FileViewer backed by the peer's data ops */}
                    <div style={{ ...box, marginTop: 10, marginBottom: 0 }}>
                      <div style={{ ...label, marginBottom: 6 }}>View a file (read-only)</div>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                        <input
                          style={{ ...input, flex: 1, minWidth: 220 }}
                          placeholder="absolute path under a peer project root, e.g. C:\\Projects\\app\\src\\index.ts"
                          value={viewPath}
                          onChange={(e) => setViewPath(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') openPeerFile(p, viewPath) }}
                        />
                        <button style={btn} onClick={() => openPeerFile(p, viewPath)}>View</button>
                      </div>
                      <div style={{ fontSize: 11, color: '#666', marginTop: 6 }}>
                        Opens the peer’s file here (read-only) with full diff support. The path is scoped server-side to the peer’s configured project roots — anything outside is refused.
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )
      })}

      {notice && <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>{notice}</div>}
    </div>
  )
}
