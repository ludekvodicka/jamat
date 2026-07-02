import { useCallback, useEffect, useState } from 'react'
import type { RemoteControlData, RemotePeer } from '../../../../../core/types/remote-control'
import { CONTROL_PORT_PACKAGED, DEFAULT_AGENT_PORT, CONTROL_PORT_MIN, CONTROL_PORT_MAX, isValidControlPort } from '../../../../../core/types/remote-control'

// The CONFIG half of the Remote Connections tab, surfaced under Settings so peers + this machine's
// key can be edited without opening the tab. It reads/writes the SAME remote-control.json over the
// SAME IPC (getRemoteConfig / saveRemoteConfig), so edits here and in the tab converge on the store
// (a panel already open reflects them after a remount). The live half — probing, the windows/tabs
// tree, viewing/driving peers, debug ops — stays in RemoteConnectionsPanel; this is settings only.

const box: React.CSSProperties = { border: '1px solid #2a2a2a', borderRadius: 6, padding: 12, marginBottom: 12 }
const label: React.CSSProperties = { fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5 }
const input: React.CSSProperties = { background: '#1e1e1e', color: '#ddd', border: '1px solid #333', borderRadius: 4, padding: '3px 6px', fontSize: 12 }
const btn: React.CSSProperties = { background: '#0e639c', color: '#fff', border: 'none', borderRadius: 4, padding: '4px 10px', fontSize: 12, cursor: 'pointer' }
const btnGhost: React.CSSProperties = { ...btn, background: '#2a2a2a' }

export function RemoteConnectionEditor() {
  const [config, setConfig] = useState<RemoteControlData | null>(null)
  const [serverInfo, setServerInfo] = useState<{ hostname: string; ips: string[] } | null>(null)
  const [bindState, setBindState] = useState<{ enabled: boolean; bound: boolean; port: number } | null>(null)
  const [revealToken, setRevealToken] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => { window.electronAPI?.getRemoteConfig?.().then(setConfig) }, [])
  useEffect(() => { window.electronAPI?.getLocalIps?.().then(setServerInfo) }, [])
  // Poll the runtime bind state so an EADDRINUSE bind failure shows instead of optimistically
  // claiming "listening" just because the config says enabled (same as the tab).
  useEffect(() => {
    const refresh = () => window.electronAPI?.getRemoteBindState?.().then(setBindState)
    refresh()
    const t = setInterval(refresh, 5000)
    return () => clearInterval(t)
  }, [])

  const save = useCallback(async (next: RemoteControlData) => {
    setConfig(next)
    await window.electronAPI?.saveRemoteConfig?.(next)
  }, [])
  // Flush the current in-memory config on blur (field edits mutate state; this persists them).
  const persist = useCallback(() => { setConfig((c) => { if (c) window.electronAPI?.saveRemoteConfig?.(c); return c }) }, [])

  const updatePeer = (id: string, patch: Partial<RemotePeer>) =>
    setConfig((c) => (c ? { ...c, peers: c.peers.map((p) => (p.id === id ? { ...p, ...patch } : p)) } : c))
  const addPeer = () => {
    if (!config) return
    const p: RemotePeer = { id: crypto.randomUUID(), name: 'New peer', host: '', controlPort: CONTROL_PORT_PACKAGED, agentPort: DEFAULT_AGENT_PORT, token: '' }
    void save({ ...config, peers: [...config.peers, p] })
  }
  const removePeer = (id: string) => { if (config) void save({ ...config, peers: config.peers.filter((p) => p.id !== id) }) }
  const toggleEnabled = () => { if (config) void save({ ...config, enabled: !config.enabled }) }

  // 24 bytes = 48 hex chars, comfortably above MIN_TOKEN_LEN (mirrors the main-process genToken).
  const genHex = (bytes = 24): string => {
    const a = new Uint8Array(bytes); crypto.getRandomValues(a)
    return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('')
  }
  const rotateToken = () => { if (!config) return; void save({ ...config, token: genHex() }); setRevealToken(true); setNotice('Token rotated — re-share it with every peer that connects') }

  if (!config) return <section className="settings-section"><h2>Remote connection</h2><div style={{ color: '#888' }}>Loading…</div></section>

  const tokenDisplay = revealToken ? config.token : '•'.repeat(Math.min((config.token ?? '').length, 16))
  const peers = config.peers ?? []

  return (
    <section className="settings-section">
      <h2>Remote connection</h2>
      <div style={{ fontSize: 12, color: '#888', marginBottom: 12, lineHeight: 1.5 }}>
        Configure LAN remote control here. Viewing &amp; driving a connected peer (its windows, tabs, debug)
        lives in the <b>Remote Connections</b> tab.
      </div>

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

      {/* ── Peers (config only — no live status/tree here) ── */}
      <div style={{ ...label, display: 'flex', alignItems: 'center', marginBottom: 6 }}>
        <span>Remote connections</span>
        <button style={{ ...btnGhost, marginLeft: 'auto' }} onClick={addPeer}>+ Add</button>
      </div>
      <div style={{ fontSize: 11, color: '#666', marginBottom: 8, lineHeight: 1.5 }}>
        <b>ctrl port</b> = the peer app's control surface (default <b>47200</b>; a dev build uses 47201) — used to view &amp; drive its tabs.{' '}
        <b>agent port</b> = the peer's always-on agent (default <b>3501</b>) — only needed to launch the app when it's closed; leave default if unused.
      </div>
      {peers.length === 0 && <div style={{ color: '#666', fontSize: 12, marginBottom: 12 }}>No peers yet. Add one above.</div>}
      {peers.map((p) => (
        <div key={p.id} style={box}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <input style={{ ...input, fontWeight: 600, flex: 1 }} placeholder="name" value={p.name} onChange={(e) => updatePeer(p.id, { name: e.target.value })} onBlur={persist} />
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
        </div>
      ))}

      {notice && <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>{notice}</div>}
    </section>
  )
}
