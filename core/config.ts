import { readFileSync, existsSync, statSync, writeFileSync, mkdirSync, renameSync } from 'fs'
import { resolve, dirname, join } from 'path'
import { homedir } from 'os'
import type { AppConfig, AgentId, Category, CategoryJson, ConfigPatch, SelfUpdateConfig, SessionDonePrompt, CustomMenuNode, ContextWarnLevel } from './types.js'
import { isAgentId } from './types.js'

interface RawConfig {
  name?: string
  categories?: CategoryJson[]
  customMenus?: unknown
  claudeUsage?: { orgId: string; sessionKey: string }
  screenOptions?: { antiFlickerScrollSpeed?: string }
  dockerIsolation?: boolean
  defaultAgent?: string
  selfUpdate?: { provider?: string; vcs?: string; repoPath?: string; autoCheck?: boolean; checkIntervalMinutes?: number }
  sessionDonePrompts?: SessionDonePrompt[]
  contextLevels?: unknown
}

/**
 * Lenient recursive parse of `customMenus` — never throws (a malformed config degrades to
 * fewer/no menu items, like the skip-don't-fail stance for categories). Enforces exactly one
 * of `items` (branch) / `run.command` (leaf); caps nesting depth as a runaway guard.
 */
export function parseCustomMenus(raw: unknown, depth = 0): CustomMenuNode[] {
  if (!Array.isArray(raw) || depth > 8) return []
  const out: CustomMenuNode[] = []
  for (const n of raw as any[]) {
    if (!n || typeof n.label !== 'string' || !n.label) continue
    const hasItems = Array.isArray(n.items)
    const hasRun = !!(n.run && typeof n.run.command === 'string' && n.run.command)
    if (hasItems === hasRun) continue // exactly one of items | run
    out.push({
      id: typeof n.id === 'string' ? n.id : undefined,
      label: n.label,
      key: typeof n.key === 'string' ? n.key.toLowerCase() : undefined,
      items: hasItems ? parseCustomMenus(n.items, depth + 1) : undefined,
      run: hasRun ? {
        command: n.run.command,
        args: Array.isArray(n.run.args) ? n.run.args.map(String) : [],
        cwd: typeof n.run.cwd === 'string' ? n.run.cwd : undefined,
        pause: n.run.pause !== false,
      } : undefined,
    })
  }
  return out
}

function parseCategory(c: CategoryJson): Category {
  return {
    label: c.label,
    path: c.path,
    hiddenFolders: new Set(c.hiddenFolders ?? []),
    virtualFolders: c.virtualFolders ?? [],
    flattenFolders: new Set(c.flattenFolders ?? []),
  }
}

// ── Per-field validators (shared by the load path `validateConfig` and the write path
//    `validateConfigPatch`). `where` labels the source in error messages (a config path on load,
//    'patch' on a UI edit). Each is a no-op for `undefined` so the patch path can call them
//    unconditionally. ──────────────────────────────────────────────────────────────────────────

function validateCategories(cats: unknown, where: string): void {
  if (!cats || !Array.isArray(cats) || cats.length === 0) {
    throw new Error(`Config ${where}: "categories" must be a non-empty array`)
  }
  for (const cat of cats as CategoryJson[]) {
    if (!cat.label || typeof cat.label !== 'string') {
      throw new Error(`Config ${where}: category missing "label"`)
    }
    if (!cat.path || typeof cat.path !== 'string') {
      throw new Error(`Config ${where}: category "${cat.label}" missing "path"`)
    }
    if (cat.virtualFolders) {
      for (const vf of cat.virtualFolders) {
        if (!vf.prefix || !vf.title) {
          throw new Error(`Config ${where}: category "${cat.label}" has virtualFolder missing prefix or title`)
        }
      }
    }
  }
}

function validateDefaultAgent(v: unknown, where: string): void {
  if (v !== undefined && !isAgentId(v)) {
    throw new Error(`Config ${where}: "defaultAgent" must be one of claude, codex (got: ${v})`)
  }
}

function validateSelfUpdate(su: RawConfig['selfUpdate'], where: string): void {
  if (su === undefined) return
  if (su.provider !== undefined && su.provider !== 'vcs' && su.provider !== 'github') {
    throw new Error(`Config ${where}: "selfUpdate.provider" must be "vcs" or "github" (got: ${su.provider})`)
  }
  if (su.vcs !== undefined && su.vcs !== 'svn' && su.vcs !== 'git') {
    throw new Error(`Config ${where}: "selfUpdate.vcs" must be "svn" or "git" (got: ${su.vcs})`)
  }
  if (su.repoPath !== undefined && typeof su.repoPath !== 'string') {
    throw new Error(`Config ${where}: "selfUpdate.repoPath" must be a string`)
  }
  if (su.autoCheck !== undefined && typeof su.autoCheck !== 'boolean') {
    throw new Error(`Config ${where}: "selfUpdate.autoCheck" must be a boolean`)
  }
  if (su.checkIntervalMinutes !== undefined &&
      (!Number.isFinite(su.checkIntervalMinutes) || su.checkIntervalMinutes <= 0)) {
    // Number.isFinite (not just typeof) so NaN/Infinity are rejected — they'd JSON.stringify to
    // `null` and brick the config on the next load.
    throw new Error(`Config ${where}: "selfUpdate.checkIntervalMinutes" must be a positive number`)
  }
}

function validateSessionDonePrompts(prompts: unknown, where: string): void {
  if (prompts === undefined) return
  if (!Array.isArray(prompts)) {
    throw new Error(`Config ${where}: "sessionDonePrompts" must be an array`)
  }
  for (const p of prompts) {
    if (!p || typeof p.label !== 'string' || !p.label) {
      throw new Error(`Config ${where}: each sessionDonePrompt needs a non-empty "label"`)
    }
    if (typeof p.prompt !== 'string' || !p.prompt) {
      throw new Error(`Config ${where}: sessionDonePrompt "${p.label}" needs a non-empty "prompt"`)
    }
  }
}

function validateContextLevels(levels: unknown, where: string): void {
  if (levels === undefined) return
  if (!Array.isArray(levels) || levels.length !== 4) {
    throw new Error(`Config ${where}: "contextLevels" must be an array of exactly 4 levels`)
  }
  for (const l of levels as any[]) {
    if (!l || !Number.isFinite(l.pct) || l.pct < 0 || l.pct > 100) {
      throw new Error(`Config ${where}: each contextLevel needs a numeric "pct" in 0–100`)
    }
    if (typeof l.popup !== 'boolean' || typeof l.statusBar !== 'boolean') {
      throw new Error(`Config ${where}: each contextLevel needs boolean "popup" and "statusBar"`)
    }
  }
}

function validateConfig(raw: RawConfig, configPath: string): void {
  validateCategories(raw.categories, configPath)
  validateSessionDonePrompts(raw.sessionDonePrompts, configPath)
  validateContextLevels(raw.contextLevels, configPath)
}

/**
 * Validate a UI config patch (the on-disk-shaped, partial edit applied by `config:update`). Only
 * the present keys are checked, reusing the same per-field validators as the load path so the UI
 * can never write a config that would fail to load. `customMenus` is intentionally NOT validated —
 * `parseCustomMenus` (run by `writeConfigPatch`) is lenient and self-sanitizing.
 */
export function validateConfigPatch(patch: ConfigPatch): void {
  if ('name' in patch && (typeof patch.name !== 'string' || !patch.name.trim())) {
    throw new Error('Config patch: "name" must be a non-empty string')
  }
  if (patch.categories !== undefined) validateCategories(patch.categories, 'patch')
  validateDefaultAgent(patch.defaultAgent, 'patch')
  validateSelfUpdate(patch.selfUpdate, 'patch')
  validateSessionDonePrompts(patch.sessionDonePrompts, 'patch')
  validateContextLevels(patch.contextLevels, 'patch')
  if ('dockerIsolation' in patch && typeof patch.dockerIsolation !== 'boolean') {
    throw new Error('Config patch: "dockerIsolation" must be a boolean')
  }
}

/**
 * Apply a UI config patch to the committed config file: read the raw JSON, overwrite ONLY the
 * present patch keys (so every untouched key — `virtualFolders`, `screenOptions`, advanced
 * per-category fields — survives), and write atomically (tmp + rename). `customMenus` is stored in
 * its sanitized form. Caller validates first (`validateConfigPatch`) and reloads after to refresh
 * the in-memory `AppConfig`. NOTE: JSON round-trip drops comments — consistent with every other
 * config writer in the app.
 */
export function writeConfigPatch(configPath: string, patch: ConfigPatch): void {
  const abs = resolve(configPath)
  const raw = JSON.parse(readFileSync(abs, 'utf-8')) as Record<string, unknown>
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    raw[key] = key === 'customMenus' ? parseCustomMenus(value) : value
  }
  const tmp = `${abs}.tmp`
  writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n', 'utf-8')
  renameSync(tmp, abs)
}

// A category whose path is missing or not a directory (detached drive, renamed
// folder). Skipping these instead of throwing keeps the rest of the menu
// usable when one location is temporarily unavailable.
function categoryPathAvailable(cat: CategoryJson): boolean {
  try {
    return existsSync(cat.path) && statSync(cat.path).isDirectory()
  } catch {
    return false
  }
}

export function loadConfig(configPath: string): AppConfig {
  const absPath = resolve(configPath)
  if (!existsSync(absPath)) {
    throw new Error(`Config file not found: ${absPath}`)
  }

  const raw: RawConfig = JSON.parse(readFileSync(absPath, 'utf-8'))
  validateConfig(raw, absPath)

  // Secret overlay: a gitignored sibling `<name>.local.json` supplies secrets kept
  // out of the committed config (currently only `claudeUsage` — the Claude.ai usage
  // credentials). Every entry point loads through here, so cli/agent/electron pick
  // it up uniformly. Absent → the base config is used as-is.
  const overlayPath = absPath.replace(/\.json$/i, '.local.json')
  if (overlayPath !== absPath && existsSync(overlayPath)) {
    try {
      const local = JSON.parse(readFileSync(overlayPath, 'utf-8')) as Partial<RawConfig>
      if (local.claudeUsage) raw.claudeUsage = local.claudeUsage
    } catch (e: any) {
      console.warn(`[config] Ignoring malformed local overlay ${overlayPath}: ${e.message}`)
    }
  }

  const skippedCategories: { label: string; path: string }[] = []
  const availableCategories = raw.categories!.filter((cat) => {
    if (categoryPathAvailable(cat)) return true
    console.warn(`[config] Skipping category "${cat.label}": path not available (${cat.path})`)
    skippedCategories.push({ label: cat.label, path: cat.path })
    return false
  })
  if (availableCategories.length === 0) {
    throw new Error(`Config ${absPath}: no categories have an accessible path (checked ${raw.categories!.length})`)
  }

  validateDefaultAgent(raw.defaultAgent, absPath)
  const defaultAgent = raw.defaultAgent as AgentId | undefined

  validateSelfUpdate(raw.selfUpdate, absPath)
  let selfUpdate: SelfUpdateConfig | undefined
  if (raw.selfUpdate !== undefined) {
    const su = raw.selfUpdate
    selfUpdate = {
      provider: su.provider as SelfUpdateConfig['provider'],
      vcs: su.vcs as SelfUpdateConfig['vcs'],
      repoPath: su.repoPath,
      autoCheck: su.autoCheck,
      checkIntervalMinutes: su.checkIntervalMinutes,
    }
  }

  return {
    name: raw.name ?? 'default',
    categories: availableCategories.map(parseCategory),
    customMenus: parseCustomMenus(raw.customMenus),
    claudeUsage: raw.claudeUsage,
    screenOptions: raw.screenOptions,
    dockerIsolation: raw.dockerIsolation,
    configPath: absPath,
    defaultAgent,
    selfUpdate,
    skippedCategories: skippedCategories.length ? skippedCategories : undefined,
    sessionDonePrompts: raw.sessionDonePrompts,
    contextLevels: raw.contextLevels as ContextWarnLevel[] | undefined,
  }
}

/** The first-run starter config seeds a single category at this folder under the user's home. */
const STARTER_PROJECTS_DIRNAME = 'JamatProjects'

/**
 * First-run bootstrap: if `targetPath` has no config yet, create a starter one from the
 * `config.example.json` template. The single seeded category is a dedicated, freshly-created
 * `JamatProjects` folder under the user's home — an always-accessible, NON-sensitive placeholder
 * so the app boots (instead of failing the "no accessible path" check) WITHOUT scoping the whole
 * home dir, which (once remote control is enabled) would widen the LAN-reachable surface to
 * dotfiles like ~/.ssh. `_README` (doc-only) and `selfUpdate` (channel differs packaged-vs-source
 * — let each runtime's default apply) are stripped; the rest is inherited. `starterCategoryPath`
 * is the seeded folder so the caller's notice can point the user at it.
 */
export function ensureConfig(targetPath: string, examplePath: string): { path: string; created: boolean; starterCategoryPath?: string } {
  const abs = resolve(targetPath)
  if (existsSync(abs)) return { path: abs, created: false }

  const base: Record<string, unknown> = existsSync(examplePath)
    ? JSON.parse(readFileSync(examplePath, 'utf-8'))
    : {}
  delete base._README
  delete base.selfUpdate
  base.name = 'My Jamat'
  const projectsDir = join(homedir(), STARTER_PROJECTS_DIRNAME)
  base.categories = [{ label: 'My Projects', path: projectsDir }]

  mkdirSync(projectsDir, { recursive: true })
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, JSON.stringify(base, null, 2) + '\n', 'utf-8')
  return { path: abs, created: true, starterCategoryPath: projectsDir }
}

/** One-time first-run notice shown after `ensureConfig` creates a starter config (CLI prints it; Electron shows it in a dialog). */
export function firstRunConfigMessage(configPath: string): string {
  const example = process.platform === 'win32' ? 'C:/Code/projects' : '/home/you/code'
  const projectsDir = join(homedir(), STARTER_PROJECTS_DIRNAME)
  return [
    'No Jamat config was found, so a starter one was created for you:',
    `  ${configPath}`,
    '',
    `It points at a new empty folder (${projectsDir}) so Jamat starts right away — put your`,
    'projects there, OR edit the "categories" list in the config to point where you already keep',
    'them (forward slashes work on every OS):',
    '',
    '  "categories": [',
    `    { "label": "My Projects", "path": "${example}" }`,
    '  ]',
    '',
    'Save the file and restart Jamat. (All config options are documented in config.example.json in the Jamat repo.)',
  ].join('\n')
}

// Self-test: run with `npx tsx core/config.ts <config-path>`. Match ONLY this file's basename —
// a loose endsWith('config.ts') also fires for importers like scripts/smoke-config.ts.
if (/[\\/]config\.(ts|js)$/.test(process.argv[1] ?? '')) {
  const configArg = process.argv[2]
  if (!configArg) {
    console.error('Usage: npx tsx core/config.ts <config-path>')
    process.exit(1)
  }
  try {
    const config = loadConfig(configArg)
    console.log('Config loaded successfully:')
    console.log(`  Name: ${config.name}`)
    console.log(`  Categories: ${config.categories.map(c => c.label).join(', ')}`)
    console.log(`  CustomMenus: ${config.customMenus?.length ?? 0} top-level group(s)`)
    console.log(`  ClaudeUsage: ${config.claudeUsage ? 'configured' : '(none)'}`)
    console.log(`  ScreenOptions: ${config.screenOptions ? JSON.stringify(config.screenOptions) : '(none)'}`)
    for (const cat of config.categories) {
      console.log(`  [${cat.label}] ${cat.path} (vfolders=${cat.virtualFolders.length})`)
    }
  } catch (e: any) {
    console.error(`Error: ${e.message}`)
    process.exit(1)
  }
}
