import { IDockviewPanelProps } from 'dockview'
import { useEffect, useState } from 'react'
import type { Ability, AbilitiesResult, PluginScope, AbilitiesManageRequest } from '../../../../../core/types/abilities'
import { AbilitiesContextMenu, type AbilitiesMenuTarget } from './AbilitiesContextMenu'
import { ConfirmDialog } from './ConfirmDialog'

const EMPTY: AbilitiesResult = { skills: [], commands: [], plugins: [], agents: [], mcp: [], instructions: [], warnings: [], homeDir: '' }

// Flat (user-level) columns. Plugins get their own expandable column rendered separately.
const FLAT: { key: 'skills' | 'commands' | 'agents' | 'mcp'; label: string; icon: string }[] = [
  { key: 'skills', label: 'Skills', icon: '🛠' },
  { key: 'commands', label: 'Commands', icon: '/' },
  { key: 'agents', label: 'Agents', icon: '🤖' },
  { key: 'mcp', label: 'MCP servers', icon: '🔌' },
]
const CHILD_KINDS: { key: 'skills' | 'commands' | 'agents'; label: string }[] = [
  { key: 'skills', label: 'Skills' },
  { key: 'commands', label: 'Commands' },
  { key: 'agents', label: 'Agents' },
]

const matches = (a: Ability, f: string) =>
  a.name.toLowerCase().includes(f) || (a.description || '').toLowerCase().includes(f)

/** Small tag marking a file/dir-backed ability as synced (symlink) or a direct local file. */
function LinkTag({ link }: { link?: 'symlink' | 'local' }) {
  if (!link) return null
  return <span className={`abilities-link abilities-link-${link}`}>{link}</span>
}

/** Plugin scope chip: green `global` (settings.json enabledPlugins) vs amber `local` (clickable -> projects). */
function ScopeChip({ scope, onToggle }: { scope?: PluginScope; onToggle?: () => void }) {
  if (!scope) return null
  if (scope.global) return <span className="abilities-scope abilities-scope-global">global</span>
  return (
    <span
      className="abilities-scope abilities-scope-local"
      title="where is it used?"
      onClick={(e) => { e.stopPropagation(); onToggle?.() }}
    >
      local{scope.refs.length ? ` · ${scope.refs.length}` : ''}
    </span>
  )
}

/**
 * Claude Abilities tab (Ctrl+Y). One-shot scan of THIS machine's ~/.claude. User-level skills /
 * commands / agents / MCP are flat columns; each row tagged symlink|local. Plugins are an
 * expandable column — click a plugin to reveal the skills/commands/agents it bundles, click a
 * child to read its description. Read-only. NO polling (one fetch on mount + a manual ↻).
 */
export function AbilitiesPanel(_props: IDockviewPanelProps) {
  const [data, setData] = useState<AbilitiesResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [openPlugins, setOpenPlugins] = useState<Set<string>>(new Set())
  const [openItems, setOpenItems] = useState<Set<string>>(new Set())
  const [openScope, setOpenScope] = useState<Set<string>>(new Set())
  const [auditOpen, setAuditOpen] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; target: AbilitiesMenuTarget } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmTarget, setConfirmTarget] = useState<AbilitiesMenuTarget | null>(null)

  const load = () => {
    setLoading(true)
    setError(null)
    const p = window.electronAPI?.listAbilities?.()
    if (!p) { setError('listAbilities unavailable'); setLoading(false); return }
    p.then((r) => { setData(r ?? EMPTY); setLoading(false) }).catch((e) => { setError(String(e)); setLoading(false) })
  }
  useEffect(load, [])

  const toggle = (set: (fn: (s: Set<string>) => Set<string>) => void, key: string) =>
    set((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n })

  const setFilter = (col: string, v: string) => setFilters((s) => ({ ...s, [col]: v }))

  // transient notice auto-clears (one-shot timer, cleaned up — not polling)
  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 6000)
    return () => clearTimeout(t)
  }, [notice])

  const onMenuAction = (action: 'enable' | 'disable') => {
    const t = menu?.target
    if (!t) return
    const req: AbilitiesManageRequest = t.kind === 'plugin'
      ? { action: action === 'enable' ? 'enablePlugin' : 'disablePlugin', name: t.id }
      : { action: action === 'enable' ? 'enableSkill' : 'disableSkill', name: t.id }
    const p = window.electronAPI?.manageAbility?.(req)
    if (!p) { setNotice('manageAbility unavailable'); return }
    p.then((r) => {
      if (r?.ok) { setNotice(`${action}d "${t.name}" — applies to new Claude sessions`); load() }
      else setNotice(`failed: ${r?.error || 'unknown error'}`)
    }).catch((e) => setNotice(`failed: ${e}`))
  }

  const doRemove = () => {
    const t = confirmTarget
    if (!t) return
    setConfirmTarget(null)
    const req: AbilitiesManageRequest = t.kind === 'plugin' ? { action: 'removePlugin', name: t.id } : { action: 'removeSkill', name: t.id }
    const p = window.electronAPI?.manageAbility?.(req)
    if (!p) { setNotice('manageAbility unavailable'); return }
    p.then((r) => {
      if (r?.ok) { setNotice(`removed "${t.name}" — applies to new Claude sessions`); load() }
      else setNotice(`failed: ${r?.error || 'unknown error'}`)
    }).catch((e) => setNotice(`failed: ${e}`))
  }

  const onMenuOpen = (where: 'window' | 'vscode') => {
    const p = menu?.target.path
    if (!p) return
    if (where === 'window') window.electronAPI?.newWindow?.(p)
    else window.electronAPI?.openInVSCode?.(p)
  }

  const nested = data ? data.plugins.reduce((n, p) => n + (p.children ? p.children.skills.length + p.children.commands.length + p.children.agents.length : 0), 0) : 0
  const flatTotal = data ? data.skills.length + data.commands.length + data.agents.length + data.mcp.length + data.plugins.length : 0

  const renderFlat = (key: 'skills' | 'commands' | 'agents' | 'mcp', icon: string, label: string) => {
    const items: Ability[] = data?.[key] ?? []
    const f = (filters[key] || '').toLowerCase()
    const shown = f ? items.filter((a) => matches(a, f)) : items
    return (
      <div className="abilities-col" key={key}>
        <div className="abilities-col-head">
          <span>{icon} {label} <span className="abilities-scope abilities-scope-global">global</span></span>
          <span className="abilities-count">{shown.length}{f ? `/${items.length}` : ''}</span>
        </div>
        <input className="abilities-filter" placeholder="filter…" value={filters[key] || ''} onChange={(e) => setFilter(key, e.target.value)} />
        <div className="abilities-list">
          {shown.length === 0 ? <div className="abilities-none">none</div> : shown.map((a, i) => {
            const ik = key + ':' + a.name + ':' + i
            const open = openItems.has(ik)
            const canOpen = !!(a.description || a.path) // clickable only when there's something to reveal
            return (
              <div
                className={'abilities-item' + (canOpen ? ' clickable' : '')}
                key={ik}
                title={a.path || ''}
                onClick={canOpen ? () => toggle(setOpenItems, ik) : undefined}
                onContextMenu={key === 'skills' ? (e) => {
                  e.preventDefault()
                  const dir = a.path ? (a.path.replace(/[\\/]SKILL\.md$/i, '').split(/[\\/]/).pop() || a.name) : a.name
                  setMenu({ x: e.clientX, y: e.clientY, target: { kind: 'skill', name: a.name, id: dir, enabled: true, toggleable: a.link === 'symlink', path: a.path } })
                } : undefined}
              >
                <div className="abilities-name">
                  {canOpen ? <span className="abilities-caret-sm">{open ? '▾' : '▸'}</span> : null}
                  {a.name}
                  {a.version ? <span className="abilities-ver"> v{a.version}</span> : null}
                  <LinkTag link={a.link} />
                </div>
                {a.description ? <div className={'abilities-desc' + (open ? ' expanded' : '')} title={a.description}>{a.description}</div> : null}
                {open && a.path ? <div className="abilities-path">{a.path}</div> : null}
                {open && a.link === 'symlink' && a.linkTarget ? <div className="abilities-path abilities-linktarget" title={a.linkTarget}>→ {a.linkTarget}</div> : null}
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  const renderInstructions = () => {
    const items: Ability[] = data?.instructions ?? []
    const f = (filters['instructions'] || '').toLowerCase()
    const shown = f ? items.filter((a) => matches(a, f)) : items
    return (
      <div className="abilities-col" key="instructions">
        <div className="abilities-col-head">
          <span>📜 Instructions</span>
          <span className="abilities-count">{shown.length}{f ? `/${items.length}` : ''}</span>
        </div>
        <input className="abilities-filter" placeholder="filter…" value={filters['instructions'] || ''} onChange={(e) => setFilter('instructions', e.target.value)} />
        <div className="abilities-list">
          {shown.length === 0 ? <div className="abilities-none">none</div> : shown.map((a, i) => {
            const ik = 'instr:' + a.name + ':' + i
            const open = openItems.has(ik)
            const canOpen = !!(a.description || a.path)
            return (
              <div
                className={'abilities-item' + (canOpen ? ' clickable' : '')}
                key={ik}
                title={a.path || ''}
                onClick={canOpen ? () => toggle(setOpenItems, ik) : undefined}
                onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, target: { kind: 'instruction', name: a.name, id: a.path || a.name, enabled: true, toggleable: false, path: a.path } }) }}
              >
                <div className="abilities-name">
                  {canOpen ? <span className="abilities-caret-sm">{open ? '▾' : '▸'}</span> : null}
                  {a.name}
                  {a.scope?.global
                    ? <span className="abilities-scope abilities-scope-global">global</span>
                    : <span className="abilities-scope abilities-scope-manual">manual</span>}
                </div>
                {a.description ? <div className={'abilities-desc' + (open ? ' expanded' : '')} title={a.description}>{a.description}</div> : null}
                {open && a.path ? <div className="abilities-path">{a.path}</div> : null}
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  const renderPlugins = () => {
    const plugins: Ability[] = data?.plugins ?? []
    const f = (filters['plugins'] || '').toLowerCase()
    const childGroups = (pl: Ability) => CHILD_KINDS.map((k) => ({ k, items: pl.children?.[k.key] ?? [] }))
    const pluginMatches = (pl: Ability) =>
      matches(pl, f) || childGroups(pl).some((g) => g.items.some((c) => matches(c, f)))
    const shown = f ? plugins.filter(pluginMatches) : plugins
    return (
      <div className="abilities-col abilities-col-plugins" key="plugins">
        <div className="abilities-col-head">
          <span>🧩 Plugins</span>
          <span className="abilities-count">{shown.length}{f ? `/${plugins.length}` : ''}</span>
        </div>
        <input className="abilities-filter" placeholder="filter plugins + their skills…" value={filters['plugins'] || ''} onChange={(e) => setFilter('plugins', e.target.value)} />
        <div className="abilities-list">
          {shown.length === 0 ? <div className="abilities-none">none</div> : shown.map((pl) => {
            const selfMatch = !f || matches(pl, f)
            const groups = childGroups(pl).map((g) => ({ k: g.k, items: f && !selfMatch ? g.items.filter((c) => matches(c, f)) : g.items }))
            const childCount = groups.reduce((n, g) => n + g.items.length, 0)
            const isOpen = openPlugins.has(pl.name) || f !== ''
            const canOpen = childCount > 0 || !!pl.path || !!pl.description // openable only with something to show
            return (
              <div className="abilities-plugin" key={pl.name}>
                <div
                  className={'abilities-plugin-summary' + (canOpen ? ' clickable' : '')}
                  onClick={canOpen ? () => toggle(setOpenPlugins, pl.name) : undefined}
                  onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, target: { kind: 'plugin', name: pl.name, id: pl.pluginKey || pl.name, enabled: !!pl.scope?.global, toggleable: !!pl.pluginKey, path: pl.path } }) }}
                  title={pl.path || ''}
                >
                  <div className="abilities-plugin-head">
                    <span className="abilities-caret">{canOpen ? (isOpen ? '▾' : '▸') : ''}</span>
                    <span className="abilities-name">{pl.name}{pl.version ? <span className="abilities-ver"> v{pl.version}</span> : null}</span>
                    <ScopeChip scope={pl.scope} onToggle={() => toggle(setOpenScope, pl.name)} />
                    <span className="abilities-count">{childCount}</span>
                  </div>
                  {pl.description ? <div className="abilities-desc abilities-plugin-desc">{pl.description}</div> : null}
                </div>
                {pl.scope && !pl.scope.global && openScope.has(pl.name) ? (
                  <div className="abilities-scope-where">
                    {pl.scope.refs.length
                      ? pl.scope.refs.map((r, i) => <div key={i} title={r.project}>{r.kind} → {r.project}</div>)
                      : <div>no project records in installed_plugins.json</div>}
                  </div>
                ) : null}
                {isOpen && canOpen && (
                  <div className="abilities-plugin-body">
                    {pl.path ? <div className="abilities-path">{pl.path}</div> : null}
                    {childCount === 0
                      ? (pl.path || pl.description ? null : <div className="abilities-none">no bundled abilities</div>)
                      : groups.map((g) => g.items.length === 0 ? null : (
                        <div className="abilities-subgroup" key={g.k.key}>
                          <div className="abilities-subhead">{g.k.label} · {g.items.length}</div>
                          {g.items.map((c) => (
                            <div className="abilities-child" key={pl.name + '/' + g.k.key + '/' + c.name} title={c.path || ''}>
                              <div className="abilities-child-name">
                                <span className="abilities-cname">{c.name}</span>
                                <LinkTag link={c.link} />
                              </div>
                              {c.description ? <div className="abilities-child-desc">{c.description}</div> : null}
                            </div>
                          ))}
                        </div>
                      ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  const renderAudit = () => {
    const plugins = data?.plugins ?? []
    return (
      <div className="abilities-audit">
        <button className="abilities-audit-toggle" onClick={() => setAuditOpen((o) => !o)}>
          {auditOpen ? '▾' : '▸'} Scope audit · {plugins.length} plugins
        </button>
        {auditOpen && (
          <table className="abilities-audit-table">
            <thead><tr><th>Plugin</th><th>Scope / where</th><th>sk</th><th>cmd</th><th>ag</th></tr></thead>
            <tbody>
              {plugins.map((p) => (
                <tr key={p.name}>
                  <td>{p.name}{p.version ? ` v${p.version}` : ''}</td>
                  <td>
                    {p.scope?.global
                      ? <span className="abilities-scope abilities-scope-global">global</span>
                      : <span className="abilities-scope abilities-scope-local">local{p.scope?.refs.length ? ` → ${p.scope.refs.map((r) => r.project.split(/[\\/]/).pop()).join(', ')}` : ''}</span>}
                  </td>
                  <td>{p.children?.skills.length ?? 0}</td>
                  <td>{p.children?.commands.length ?? 0}</td>
                  <td>{p.children?.agents.length ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    )
  }

  return (
    <div className="abilities-panel">
      <div className="abilities-header">
        <span className="abilities-title">🧰 Claude Abilities</span>
        {data && <span className="abilities-sub" title={data.homeDir}>{flatTotal} + {nested} in plugins · {data.homeDir}</span>}
        <button className="abilities-refresh" onClick={load} title="Rescan ~/.claude">↻</button>
      </div>
      {notice ? <div className="abilities-notice" onClick={() => setNotice(null)}>{notice}</div> : null}

      {loading && !data ? (
        <div className="abilities-status">Scanning ~/.claude…</div>
      ) : error ? (
        <div className="abilities-status" style={{ color: '#d29922' }}>{error}</div>
      ) : (
        <>
          {renderAudit()}
          <div className="abilities-columns">
            {FLAT.map((c) => renderFlat(c.key, c.icon, c.label))}
            {renderInstructions()}
            {renderPlugins()}
          </div>
        </>
      )}
      {menu ? <AbilitiesContextMenu x={menu.x} y={menu.y} target={menu.target} onAction={onMenuAction} onRemove={() => setConfirmTarget(menu.target)} onOpen={onMenuOpen} onClose={() => setMenu(null)} /> : null}
      {confirmTarget ? (
        <ConfirmDialog
          title={confirmTarget.kind === 'plugin' ? 'Remove plugin' : 'Remove skill'}
          message={confirmTarget.kind === 'plugin'
            ? `Remove plugin "${confirmTarget.name}"? Delists it from installed_plugins.json + enabledPlugins and deletes its cache folder. Applies to new Claude sessions.`
            : `Remove skill "${confirmTarget.name}"? This DELETES its source in the claude-extensions repo (irreversible) and removes the symlink. Applies to new Claude sessions.`}
          confirmLabel="Remove"
          danger
          onConfirm={doRemove}
          onCancel={() => setConfirmTarget(null)}
        />
      ) : null}
    </div>
  )
}
