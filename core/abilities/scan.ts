/**
 * Scan a machine's Claude config for "abilities" — skills, slash commands, plugins,
 * agents, MCP servers — with name + description. Pure fs (no electron), so it's
 * unit-testable headless and importable from the Electron main process (ipc-abilities.ts).
 *
 * Sources (all best-effort; a missing/broken source contributes a warning, never throws):
 *   skills   ~/.claude/skills/<name>/SKILL.md           (frontmatter name + description)
 *   commands ~/.claude/commands/*.md                    (frontmatter, else filename + first line)
 *   agents   ~/.claude/agents/*.md                      (frontmatter name + description)
 *   plugins  ~/.claude/plugins/installed_plugins.json   (+ each installPath's manifest + nested skills/commands/agents)
 *   mcp      ~/.claude.json mcpServers                  (name + command summary)
 *
 * No interval/polling — this is a one-shot scan run on tab open (see the recent-files freeze lesson).
 */

import { readdirSync, readFileSync, readlinkSync, existsSync, type Dirent } from 'fs'
import { join, dirname, resolve } from 'path'
import { homedir } from 'os'
import type { Ability, AbilityChildren, AbilitiesResult, PluginScope, PluginScopeRef } from '../types/abilities.js'

const MAX_FILES = 5000 // safety cap so a pathological tree can never block the scanner

/** Parse leading YAML front-matter for `name:` / `description:` — handles inline values AND
 *  block scalars (`description: |` / `>`). No YAML dep (core/ is zero-dep). */
function parseFront(content: string): { name?: string; description?: string } {
  if (!content.startsWith('---')) return {}
  const end = content.indexOf('\n---', 3)
  if (end === -1) return {}
  const lines = content.slice(3, end).split('\n')
  const grab = (key: string): string | undefined => {
    const idx = lines.findIndex((l) => l.startsWith(key + ':'))
    if (idx === -1) return undefined
    const inline = lines[idx].slice(key.length + 1).trim()
    if (/^[|>][+-]?$/.test(inline)) {
      // YAML block scalar — collect the following indented lines until dedent.
      const block: string[] = []
      for (let i = idx + 1; i < lines.length; i++) {
        if (lines[i].trim() === '') { block.push(''); continue }
        if (/^\s/.test(lines[i])) block.push(lines[i].replace(/^\s+/, '')); else break
      }
      return block.join(inline[0] === '>' ? ' ' : '\n').trim() || undefined
    }
    let v = inline
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    return v || undefined
  }
  return { name: grab('name'), description: grab('description') }
}

/** First non-empty, non-heading prose line of a markdown body (used when a command has no frontmatter). */
function firstProseLine(content: string): string | undefined {
  let body = content
  if (content.startsWith('---')) { const e = content.indexOf('\n---', 3); if (e !== -1) body = content.slice(e + 4) }
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('---') || line.startsWith('<')) continue
    return line.replace(/[*_`]/g, '').slice(0, 200)
  }
  return undefined
}

function safeRead(p: string): string | null {
  try { return readFileSync(p, 'utf-8') } catch { return null }
}
function safeDirents(dir: string): Dirent[] {
  try { return readdirSync(dir, { withFileTypes: true }) } catch { return [] }
}
function fileBase(name: string): string {
  return name.replace(/\.md$/i, '')
}
/** Resolve a symlink/junction's target for display (strips the Windows `\\?\` device prefix). */
function readlinkTarget(p: string): string | undefined {
  try { return readlinkSync(p).replace(/^\\\\\?\\/, '') || undefined } catch { return undefined }
}

interface Ctx { count: number; warnings: string[] }

/** Skills: a dir of `<name>/SKILL.md`. Entries may be real dirs OR symlinks/junctions
 *  (skills are commonly symlinked into ~/.claude/skills) — `Dirent.isDirectory()` is false
 *  for a symlink, so we don't gate on it: we just try to read `<entry>/SKILL.md` (a plain
 *  file yields ENOTDIR → null → skipped). */
function scanSkills(dir: string, source: string, ctx: Ctx): Ability[] {
  if (!existsSync(dir)) return []
  const out: Ability[] = []
  for (const e of safeDirents(dir)) {
    if (++ctx.count > MAX_FILES) break
    const entry = join(dir, e.name)
    const skillFile = join(entry, 'SKILL.md')
    const content = safeRead(skillFile)
    if (content === null) continue
    const fm = parseFront(content)
    const isSym = e.isSymbolicLink()
    // Many skills have no frontmatter `description:` (just an H1 + prose). Fall back to the
    // first prose line of the body, same as commands — that's what browser-obscura etc. use.
    out.push({ kind: 'skill', name: fm.name || e.name, description: fm.description || firstProseLine(content), source, path: skillFile, link: isSym ? 'symlink' : 'local', linkTarget: isSym ? readlinkTarget(entry) : undefined })
  }
  return out
}

/** A dir of `*.md` files (commands / agents). */
function scanMdDir(dir: string, source: string, kind: 'command' | 'agent', ctx: Ctx): Ability[] {
  if (!existsSync(dir)) return []
  const out: Ability[] = []
  for (const e of safeDirents(dir)) {
    if (e.isDirectory() || !/\.md$/i.test(e.name) || ++ctx.count > MAX_FILES) continue
    const file = join(dir, e.name)
    const content = safeRead(file)
    if (content === null) continue
    const fm = parseFront(content)
    const isSym = e.isSymbolicLink()
    out.push({
      kind,
      name: fm.name || fileBase(e.name),
      description: fm.description || (kind === 'command' ? firstProseLine(content) : undefined),
      source,
      path: file,
      link: isSym ? 'symlink' : 'local',
      linkTarget: isSym ? readlinkTarget(file) : undefined,
    })
  }
  return out
}

/** MCP servers from ~/.claude.json `mcpServers`. Description = a terse command/type summary. */
function scanMcp(claudeJsonPath: string, ctx: Ctx): Ability[] {
  const content = safeRead(claudeJsonPath)
  if (content === null) return []
  let json: any
  try { json = JSON.parse(content) } catch { ctx.warnings.push('~/.claude.json: invalid JSON'); return [] }
  const servers = json?.mcpServers
  if (!servers || typeof servers !== 'object') return []
  const out: Ability[] = []
  for (const name of Object.keys(servers)) {
    const s = servers[name] || {}
    let desc: string | undefined
    if (s.type === 'http' || s.type === 'sse' || s.url) desc = `${s.type || 'http'} ${s.url || ''}`.trim()
    else if (s.command) desc = [s.command, ...(Array.isArray(s.args) ? s.args : [])].join(' ').slice(0, 200)
    out.push({ kind: 'mcp', name, description: desc, source: 'user', path: claudeJsonPath })
  }
  return out
}

/** Globally-enabled plugin keys from ~/.claude/settings.json `enabledPlugins` ({ "name@marketplace": true }). */
function readEnabledPlugins(claudeDir: string, ctx: Ctx): Record<string, boolean> {
  const content = safeRead(join(claudeDir, 'settings.json'))
  if (content === null) return {}
  try {
    const ep = JSON.parse(content)?.enabledPlugins
    return ep && typeof ep === 'object' ? ep : {}
  } catch { ctx.warnings.push('settings.json: invalid JSON'); return {} }
}

/** Derive a plugin's scope: global (settings.json enabledPlugins) + per-project install records. */
function pluginScope(key: string, records: any[], enabled: Record<string, boolean>): PluginScope {
  const refs: PluginScopeRef[] = []
  const seen = new Set<string>()
  for (const r of records) {
    if (!r || typeof r.projectPath !== 'string') continue
    if (r.scope !== 'project' && r.scope !== 'local') continue
    if (seen.has(r.projectPath)) continue
    seen.add(r.projectPath)
    refs.push({ kind: r.scope, project: r.projectPath })
  }
  return { global: enabled[key] === true, refs }
}

/** Plugins from installed_plugins.json; each plugin's nested skills/commands/agents are attached
 *  as `children` (shown when the plugin row is expanded), NOT surfaced in the top-level columns. */
function scanPlugins(claudeDir: string, ctx: Ctx): Ability[] {
  const file = join(claudeDir, 'plugins', 'installed_plugins.json')
  const content = safeRead(file)
  const plugins: Ability[] = []
  if (content === null) return plugins
  let json: any
  try { json = JSON.parse(content) } catch { ctx.warnings.push('installed_plugins.json: invalid JSON'); return plugins }
  const map = json?.plugins
  if (!map || typeof map !== 'object') return plugins
  const enabled = readEnabledPlugins(claudeDir, ctx)

  for (const key of Object.keys(map)) {
    const records = Array.isArray(map[key]) ? map[key] : []
    const rec = records[0] || {}
    const pluginName = key.split('@')[0]
    const installPath: string | undefined = typeof rec.installPath === 'string' ? rec.installPath : undefined
    // Plugin manifest (best-effort): .claude-plugin/plugin.json or plugin.json at the install root.
    let description: string | undefined
    if (installPath) {
      for (const mf of [join(installPath, '.claude-plugin', 'plugin.json'), join(installPath, 'plugin.json')]) {
        const m = safeRead(mf)
        if (m) { try { description = JSON.parse(m)?.description } catch {} ; if (description) break }
      }
    }
    // Recurse the plugin's own abilities into children (tag the source).
    const children: AbilityChildren = { skills: [], commands: [], agents: [] }
    if (installPath && existsSync(installPath)) {
      const src = `plugin:${pluginName}`
      children.skills = scanSkills(join(installPath, 'skills'), src, ctx).sort(byName)
      children.commands = scanMdDir(join(installPath, 'commands'), src, 'command', ctx).sort(byName)
      children.agents = scanMdDir(join(installPath, 'agents'), src, 'agent', ctx).sort(byName)
    }
    plugins.push({ kind: 'plugin', name: pluginName, description, source: 'user', path: installPath, version: typeof rec.version === 'string' ? rec.version : undefined, children, scope: pluginScope(key, records, enabled), pluginKey: key })
  }
  return plugins
}

/** Collect files reachable from `start` via CLAUDE.md `@`-imports (depth/count capped). Used to mark
 *  which instruction files are auto-loaded everywhere (reachable from the root ~/.claude/CLAUDE.md). */
function collectImports(start: string, homeDir: string, ctx: Ctx): Set<string> {
  const seen = new Set<string>()
  const norm = (p: string) => resolve(p).toLowerCase()
  const walk = (file: string, depth: number): void => {
    if (depth > 5 || ++ctx.count > MAX_FILES) return
    const content = safeRead(file)
    if (content === null) return
    const dir = dirname(file)
    for (const line of content.split('\n')) {
      const m = line.match(/^\s*@(\S+)/)
      if (!m) continue
      let p = m[1]
      if (p.startsWith('~')) p = join(homeDir, p.slice(1).replace(/^[\\/]/, ''))
      else if (!/^[a-zA-Z]:[\\/]/.test(p) && !p.startsWith('\\') && !p.startsWith('/')) p = join(dir, p)
      const abs = norm(p)
      if (seen.has(abs)) continue
      seen.add(abs)
      walk(p, depth + 1) // follow nested imports (CLAUDE.md → index.md → rule files)
    }
  }
  walk(start, 0)
  return seen
}

/** First markdown heading (`# …`) or first prose line — the instruction file's display description. */
function instructionDesc(content: string): string | undefined {
  for (const raw of content.split('\n')) {
    const l = raw.trim()
    if (!l) continue
    if (l.startsWith('#')) return l.replace(/^#+\s*/, '').slice(0, 200)
    if (l.startsWith('@') || l.startsWith('<') || l.startsWith('---')) continue
    return l.replace(/[*_`]/g, '').slice(0, 200)
  }
  return undefined
}

/** Custom instruction files: ~/.claude/CLAUDE.md(.local.md) + extensions/instructions/*.md.
 *  scope.global = the root CLAUDE.md itself, or reachable from its @-import graph (auto-loaded). */
function scanInstructions(homeDir: string, ctx: Ctx): Ability[] {
  const claudeDir = join(homeDir, '.claude')
  const root = join(claudeDir, 'CLAUDE.md')
  const imported = collectImports(root, homeDir, ctx)
  const out: Ability[] = []
  const add = (file: string, name: string, alwaysGlobal = false): void => {
    const content = safeRead(file)
    if (content === null) return
    const global = alwaysGlobal || imported.has(resolve(file).toLowerCase())
    out.push({ kind: 'instruction', name, description: instructionDesc(content), source: 'user', path: file, scope: { global, refs: [] } })
  }
  if (existsSync(root)) add(root, 'CLAUDE.md', true)
  const local = join(claudeDir, 'CLAUDE.local.md')
  if (existsSync(local)) add(local, 'CLAUDE.local.md', true)
  const instrDir = join(claudeDir, 'extensions', 'instructions')
  for (const e of safeDirents(instrDir)) {
    if (e.isDirectory() || !/\.md$/i.test(e.name) || ++ctx.count > MAX_FILES) continue
    add(join(instrDir, e.name), e.name)
  }
  return out
}

const byName = (a: Ability, b: Ability) => a.name.localeCompare(b.name)

export function scanAbilities(homeDir: string): AbilitiesResult {
  const ctx: Ctx = { count: 0, warnings: [] }
  const claudeDir = join(homeDir, '.claude')

  const skills = scanSkills(join(claudeDir, 'skills'), 'user', ctx)
  const commands = scanMdDir(join(claudeDir, 'commands'), 'user', 'command', ctx)
  const agents = scanMdDir(join(claudeDir, 'agents'), 'user', 'agent', ctx)
  const mcp = scanMcp(join(homeDir, '.claude.json'), ctx)
  const plugins = scanPlugins(claudeDir, ctx)
  const instructions = scanInstructions(homeDir, ctx)

  if (ctx.count > MAX_FILES) ctx.warnings.push(`scan capped at ${MAX_FILES} entries`)

  return {
    skills: skills.sort(byName),
    commands: commands.sort(byName),
    plugins: plugins.sort(byName),
    agents: agents.sort(byName),
    mcp: mcp.sort(byName),
    instructions: instructions.sort(byName),
    warnings: ctx.warnings,
    homeDir,
  }
}

// Self-test: `npx tsx core/abilities/scan.ts [homeDir]`
if (process.argv[1]?.replace(/\\/g, '/').endsWith('core/abilities/scan.ts')) {
  const home = process.argv[2] || homedir()
  const r = scanAbilities(home)
  console.log(`Abilities under ${home}/.claude:`)
  for (const k of ['skills', 'commands', 'plugins', 'agents', 'mcp', 'instructions'] as const) {
    console.log(`\n[${k}] ${(r as any)[k].length}`)
    for (const a of (r as any)[k].slice(0, 8)) {
      let tag = ''
      if (a.kind === 'plugin') {
        const sc = a.scope?.global ? '[global]' : `[local→${a.scope?.refs.map((x: PluginScopeRef) => x.project.split(/[\\/]/).pop()).join(',') || '?'}]`
        tag = ` ${sc} (skills:${a.children?.skills.length ?? 0} cmds:${a.children?.commands.length ?? 0} agents:${a.children?.agents.length ?? 0})`
      } else if (a.kind === 'instruction') tag = a.scope?.global ? ' [global]' : ' [manual]'
      else if (a.link) tag = ` [${a.link}]`
      console.log(`  - ${a.name}${tag}: ${(a.description || '').slice(0, 70)}`)
    }
  }
  if (r.warnings.length) console.log('\nwarnings:', r.warnings)
}
