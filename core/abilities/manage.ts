/**
 * Mutating operations for the Abilities tab — the FIRST write path into ~/.claude.
 * Pure fs (paths param'd, no electron) so it's headless-testable; the electron handler
 * (app-electron/src/main/ipc-abilities.ts) calls these with homedir().
 *
 * Safety (plan 2026-06-03-002 + research):
 *  - settings.json is edited via true read-modify-write: parse -> mutate ONE key -> stringify the
 *    whole object -> write tmp + atomic rename. A malformed file is NEVER clobbered (we refuse).
 *  - skill names are turned into paths, so they're strictly sanitized (^[A-Za-z0-9_-]+$). Plugin
 *    keys are only used as JSON map keys (never pathed) so they get a looser bounded check.
 *  - skill disable removes only the SYMLINK (the extensions-repo source is left intact); we refuse
 *    to delete a path that isn't actually a symlink.
 */

import { readFileSync, writeFileSync, renameSync, existsSync, lstatSync, symlinkSync, rmSync } from 'fs'
import { join, resolve, sep } from 'path'
import type { AbilitiesManageRequest, AbilitiesManageResult } from '../types/abilities.js'

type R = AbilitiesManageResult
const OK: R = { ok: true }
const fail = (error: string): R => ({ ok: false, error })

const SAFE_SKILL = /^[A-Za-z0-9_-]+$/        // pathed → strict
const SAFE_KEY = /^[A-Za-z0-9_.@/-]+$/       // settings.json map key only → bounded, allows @ and /

/** True iff `target` resolves to `root` itself or a path inside it — guards every destructive rm. */
function insideRoot(target: string, root: string): boolean {
  const t = resolve(target)
  const r = resolve(root)
  return t === r || t.startsWith(r + sep)
}

function readJson(path: string): { ok: true; value: any } | { ok: false; error: string } {
  if (!existsSync(path)) return { ok: true, value: {} }
  let raw: string
  try { raw = readFileSync(path, 'utf-8') } catch (e) { return { ok: false, error: `read ${path}: ${e}` } }
  try { return { ok: true, value: JSON.parse(raw) } } catch { return { ok: false, error: `${path} is not valid JSON — refusing to modify it` } }
}

function writeJsonAtomic(path: string, obj: unknown): R {
  try {
    const tmp = path + '.tmp'
    writeFileSync(tmp, JSON.stringify(obj, null, 2))
    renameSync(tmp, path)
    return OK
  } catch (e) { return fail(`write ${path}: ${e}`) }
}

/** Toggle a plugin's key in ~/.claude/settings.json `enabledPlugins` (enable = true / disable = delete key). */
export function setPluginEnabled(claudeDir: string, key: string, enabled: boolean): R {
  if (!SAFE_KEY.test(key)) return fail(`invalid plugin key: ${key}`)
  const settingsPath = join(claudeDir, 'settings.json')
  const read = readJson(settingsPath)
  if (!read.ok) return fail(read.error)
  const obj = (read.value && typeof read.value === 'object') ? read.value : {}
  const ep = (obj.enabledPlugins && typeof obj.enabledPlugins === 'object') ? obj.enabledPlugins : {}
  if (enabled) ep[key] = true
  else delete ep[key]
  obj.enabledPlugins = ep
  return writeJsonAtomic(settingsPath, obj)
}

/** Enable = (re)create the ~/.claude/skills/<name> junction to extensions/skills/<name>;
 *  disable = remove that symlink only (the extensions-repo source is untouched). */
export function setSkillEnabled(claudeDir: string, name: string, enabled: boolean): R {
  if (!SAFE_SKILL.test(name)) return fail(`invalid skill name: ${name}`)
  const link = join(claudeDir, 'skills', name)
  if (enabled) {
    const target = join(claudeDir, 'extensions', 'skills', name)
    if (!existsSync(target)) return fail(`skill source not found: ${target}`)
    if (existsSync(link)) return OK // already enabled
    try { symlinkSync(target, link, 'junction') } catch (e) { return fail(`symlink ${link}: ${e}`) }
    return OK
  }
  // disable
  if (!existsSync(link)) return OK // already disabled
  let st
  try { st = lstatSync(link) } catch (e) { return fail(`lstat ${link}: ${e}`) }
  if (!st.isSymbolicLink()) return fail(`${link} is not a symlink — refusing to delete a real directory`)
  try { rmSync(link, { recursive: true, force: true }) } catch (e) { return fail(`remove ${link}: ${e}`) }
  return OK
}

/** Uninstall a plugin: delist from installed_plugins.json + enabledPlugins, then delete its
 *  cache install dir(s) (only those inside ~/.claude/plugins). Irreversible. */
export function removePlugin(claudeDir: string, key: string): R {
  if (!SAFE_KEY.test(key)) return fail(`invalid plugin key: ${key}`)
  const pluginsRoot = join(claudeDir, 'plugins')
  const ipPath = join(pluginsRoot, 'installed_plugins.json')
  const read = readJson(ipPath)
  if (!read.ok) return fail(read.error)
  const json = (read.value && typeof read.value === 'object') ? read.value : {}
  const map = (json.plugins && typeof json.plugins === 'object') ? json.plugins : {}
  if (!(key in map)) {
    // clear a possibly-dangling global enable, then report it wasn't installed
    setPluginEnabled(claudeDir, key, false)
    return fail(`plugin not found in installed_plugins.json: ${key}`)
  }
  const records = Array.isArray(map[key]) ? map[key] : []
  // 1) delete cache install dirs FIRST (only those inside ~/.claude/plugins). If this fails — e.g. a
  //    running Claude has the folder locked on Windows — nothing is delisted yet, so the plugin stays
  //    fully intact and the action is safely retryable (no confusing half-removed state).
  for (const rec of records) {
    const ip = typeof rec?.installPath === 'string' ? rec.installPath : null
    if (ip && existsSync(ip) && insideRoot(ip, pluginsRoot)) {
      try { rmSync(ip, { recursive: true, force: true }) } catch (e) { return fail(`could not delete ${ip} — close any running Claude using this plugin, then retry: ${e}`) }
    }
  }
  // 2) delist from installed_plugins.json + clear the global enable
  delete map[key]
  json.plugins = map
  const w = writeJsonAtomic(ipPath, json)
  if (!w.ok) return w
  setPluginEnabled(claudeDir, key, false)
  return OK
}

/** Delete a user skill: remove its ~/.claude/skills symlink AND its source under
 *  Q:/Tooling/agent_extensions/skills (IRREVERSIBLE — that's the claude-extensions working copy). */
export function removeSkill(claudeDir: string, name: string): R {
  if (!SAFE_SKILL.test(name)) return fail(`invalid skill name: ${name}`)
  const link = join(claudeDir, 'skills', name)
  const extRoot = join(claudeDir, 'extensions', 'skills')
  const source = join(extRoot, name)
  // 1) remove the symlink (only if it's actually a symlink)
  if (existsSync(link)) {
    let st
    try { st = lstatSync(link) } catch (e) { return fail(`lstat ${link}: ${e}`) }
    if (!st.isSymbolicLink()) return fail(`${link} is not a symlink — refusing to delete a real directory`)
    try { rmSync(link, { recursive: true, force: true }) } catch (e) { return fail(`remove ${link}: ${e}`) }
  }
  // 2) delete the source (irreversible) — only if inside extensions/skills
  if (existsSync(source)) {
    if (!insideRoot(source, extRoot)) return fail(`refusing to delete outside ${extRoot}`)
    try { rmSync(source, { recursive: true, force: true }) } catch (e) { return fail(`remove ${source}: ${e}`) }
  }
  return OK
}

/** Resolve a plugin identifier (full `name@marketplace` key OR a bare `name`) to the installed key.
 *  enabledPlugins + installed_plugins.json are keyed by the FULL key, so an older UI that only had
 *  the bare name (pre-pluginKey) still resolves correctly. Unknown → returned as-is (fails downstream). */
function resolvePluginKey(claudeDir: string, idOrName: string): string {
  const read = readJson(join(claudeDir, 'plugins', 'installed_plugins.json'))
  const map = read.ok && read.value?.plugins && typeof read.value.plugins === 'object' ? read.value.plugins : {}
  if (idOrName in map) return idOrName
  return Object.keys(map).find((k) => k.split('@')[0] === idOrName) || idOrName
}

/** Dispatch a manage request (enable/disable/remove for plugins + user skills).
 *  Takes the HOME dir and derives `.claude` itself — mirrors `scanAbilities(homeDir)`, so the
 *  electron handler passes `homedir()` for both. (The granular fns above take the `.claude` dir.) */
export function manageAbility(homeDir: string, req: AbilitiesManageRequest): R {
  const claudeDir = join(homeDir, '.claude')
  switch (req?.action) {
    case 'enablePlugin': return setPluginEnabled(claudeDir, resolvePluginKey(claudeDir, req.name), true)
    case 'disablePlugin': return setPluginEnabled(claudeDir, resolvePluginKey(claudeDir, req.name), false)
    case 'enableSkill': return setSkillEnabled(claudeDir, req.name, true)
    case 'disableSkill': return setSkillEnabled(claudeDir, req.name, false)
    case 'removePlugin': return removePlugin(claudeDir, resolvePluginKey(claudeDir, req.name))
    case 'removeSkill': return removeSkill(claudeDir, req.name)
    default: return fail(`unsupported action: ${req?.action}`)
  }
}
