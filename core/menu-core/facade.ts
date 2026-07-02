import type { AppConfig, MenuState, StatsMap } from '../types.js'
import { SEARCH_ITEM } from '../types.js'
import { DEFAULT_AGENT_ID } from '../types/contracts.js'
import { listAvailableAgents, getAgent } from '../agents/index.js'
import { getFolders, buildMenuEntries, loadProjectConfig } from './projects.js'
import { loadStats, getStatsPath } from './stats.js'
import { computeLayout } from './transitions.js'

export { clampScroll, applySearch, enterSearch, exitSearch, enterVirtualFolder, exitVirtualFolder, switchCategory, openSessionPicker, rebuildItems, invalidateCaches } from './transitions.js'
export { matchesVirtualPrefix, moveProjectPrefix, renameProject } from './projects.js'
export { loadProjectConfig } from './projects.js'
export { statsKey, saveStats, recordUsage, loadStats, getStatsPath } from './stats.js'

export function createMenuState(config: AppConfig, prefs: { antiFlicker: boolean }, configDir?: string): MenuState {
  const categories = config.categories
  const cat = categories[0]
  const statsFile = getStatsPath(configDir)
  const stats = loadStats(statsFile)
  const initialFolders = getFolders(cat, stats, 'usage')
  const allEntries = buildMenuEntries(cat, initialFolders, null, true)

  // Agent picker state. `availableAgents` is the PATH-filtered list (so
  // Codex disappears until installed). `selectedAgent` defaults to the
  // config's preference, falling back to whatever is actually available,
  // then DEFAULT_AGENT_ID. Resume rows can still override at spawn time.
  // Computed BEFORE the session-meta cache so the cache is built through the
  // SELECTED agent's adapter, not a hard-coded Claude import.
  const available = listAvailableAgents().map((a) => a.id)
  const configDefault = config.defaultAgent
  let selectedAgent: typeof DEFAULT_AGENT_ID
  if (configDefault && available.includes(configDefault)) {
    selectedAgent = configDefault
  } else {
    if (configDefault && !available.includes(configDefault)) {
      // User explicitly asked for an agent that isn't on PATH — surface
      // so the silent downgrade doesn't confuse anyone migrating between
      // backends.
      console.warn(`[menu] defaultAgent=${configDefault} requested but not on PATH; falling back to ${available[0] ?? DEFAULT_AGENT_ID}`)
    }
    selectedAgent = available[0] ?? DEFAULT_AGENT_ID
  }
  const sessionMetaCache = getAgent(selectedAgent).buildSessionMetaCache(cat.path, initialFolders)

  const s: MenuState = {
    categories,
    catIndex: 0,
    cat,
    stats,
    scrollOffset: 0,
    submenu: null,
    customMenus: config.customMenus ?? [],
    customPath: [],
    customTargetDir: null,
    searchMode: false,
    searchQuery: '',
    sortMode: 'usage',
    virtualFoldersEnabled: true,
    currentVirtualFolder: null,
    allEntries,
    items: [SEARCH_ITEM, ...allEntries],
    selected: allEntries.length > 0 ? 1 : 0,
    tabMemory: new Map(),
    jumpChar: '',
    jumpLastIndex: -1,
    visibleRows: Math.max(5, (process.stdout.rows || 24) - 10),
    spItems: [],
    spSessions: [],
    spSelected: 0,
    spScrollOffset: 0,
    spFolderName: '',
    spPreviewCache: new Map(),
    spProjectDir: null,
    mpTargets: [],
    mpSelected: 0,
    mpFolderName: '',
    cachedFolderNames: initialFolders,
    crossFolderCache: new Map(),
    sessionMetaCache,
    layout: { maxNameW: 0, maxActivityW: 0, projectConfigs: new Map() },
    antiFlicker: prefs.antiFlicker,
    dockerIsolationEnabled: config.dockerIsolation !== false,
    selectedAgent,
    availableAgents: available,
  }
  s.layout = computeLayout(s)
  return s
}

export function getSessionPreview(s: MenuState): string[] {
  const item = s.spItems[s.spSelected]
  if (!item || item.kind === 'new-session' || !s.spProjectDir) return []
  const sess = item.session
  if (s.spPreviewCache.has(sess.sessionId)) return s.spPreviewCache.get(sess.sessionId)!
  const preview = getAgent(s.selectedAgent).loadSessionPreview(s.spProjectDir, sess.sessionId)
  s.spPreviewCache.set(sess.sessionId, preview)
  return preview
}
