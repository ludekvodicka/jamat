/**
 * Shared manifest for the Demo sandbox — a fake project tree + a fake Claude config
 * dir used to produce clean screenshots of the project selector, opened Claude tabs,
 * and the Usage Stats dashboard WITHOUT exposing real projects.
 *
 * Consumed by:
 *   - scripts/seed-demo-projects.ts       → scaffolds Q:\Demo\<category>\<project> trees
 *   - scripts/seed-demo-stats.ts          → fabricates ccusage transcripts in Q:\Demo\.claude-demo
 *   - .private/configs/demo/config.json   → the "Demo" profile points its categories here
 *
 * Nothing here touches real data. The token dashboard is isolated via CLAUDE_CONFIG_DIR and
 * CODEX_HOME, so the real ~/.claude and ~/.codex stores are never read or written by the demo.
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/** Top-level root for the demo project tree (sibling of your real project roots). */
export const DEMO_ROOT = 'Q:\\Demo'

/**
 * Isolated Claude config dir for the demo. ccusage reads ONLY this when CLAUDE_CONFIG_DIR
 * points here; Claude Code CLI also relocates its home here, so demo sessions never mix
 * with real history. Lives inside DEMO_ROOT but is dot-prefixed → hidden from the selector.
 */
export const DEMO_CLAUDE_DIR = 'Q:\\Demo\\.claude-demo'

/** Isolated Codex home used by demo sessions and the unified usage dashboard. */
export const DEMO_CODEX_DIR = 'Q:\\Demo\\.codex-demo'

/**
 * Portable config-dir the demo Electron instance launches with (JAMAT_CONFIG_DIR, via
 * .private/scripts/start-demo.bat). All demo-profile state — the fabricated Usage Stats
 * (stats/) and the per-project launch counts (usage-stats.json) — MUST land HERE, because a
 * config-dir launch reads them from <config-dir>/…, not from %APPDATA%\jamat. Lives in .private/
 * (SVN-only, never public), alongside the other per-user profiles.
 */
export const DEMO_CONFIG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '.private', 'configs', 'demo')

export type Stack = 'web' | 'backend' | 'ai' | 'home'

export interface DemoProject {
  name: string
  desc: string
}

export interface DemoCategory {
  /** Category label shown in the selector (also the on-disk folder name under DEMO_ROOT). */
  label: string
  stack: Stack
  projects: DemoProject[]
}

export const DEMO_CATEGORIES: DemoCategory[] = [
  {
    label: 'ApplicationsWeb',
    stack: 'web',
    projects: [
      { name: 'ShopFront', desc: 'Customer-facing storefront with cart and checkout.' },
      { name: 'AdminDashboard', desc: 'Internal admin panel for orders, users and metrics.' },
      { name: 'PortfolioSite', desc: 'Marketing and portfolio site with a CMS-driven blog.' },
      { name: 'BlogPlatform', desc: 'Multi-author publishing platform with MDX articles.' },
    ],
  },
  {
    label: 'ApplicationsBackend',
    stack: 'backend',
    projects: [
      { name: 'AuthService', desc: 'JWT auth, sessions and role-based access control.' },
      { name: 'PaymentGateway', desc: 'Payment intents, webhooks and reconciliation.' },
      { name: 'NotificationWorker', desc: 'Queue-driven email / push notification dispatcher.' },
      { name: 'ApiGateway', desc: 'Edge router, rate limiting and request aggregation.' },
    ],
  },
  {
    label: 'ApplicationsAI',
    stack: 'ai',
    projects: [
      { name: 'ChatAssistant', desc: 'Streaming chat assistant over a tool-calling loop.' },
      { name: 'DocSummarizer', desc: 'Long-document chunking and map-reduce summaries.' },
      { name: 'ImageTagger', desc: 'Vision pipeline that auto-tags an image library.' },
      { name: 'RagPipeline', desc: 'Embeddings, vector search and grounded answers.' },
    ],
  },
  {
    label: 'House',
    stack: 'home',
    projects: [
      { name: 'Pool', desc: 'Backyard pool build — quotes, permits, pump and maintenance notes.' },
      { name: 'Garden', desc: 'Garden landscaping — beds, irrigation and a planting calendar.' },
      { name: 'Electrics', desc: 'House rewiring — circuit inventory, electrician quotes and safety checks.' },
      { name: 'Renovation', desc: 'Kitchen renovation — measurements, contractor bids and a task list.' },
      { name: 'Heating', desc: 'Heat-pump install — quotes, sizing and running-cost notes.' },
    ],
  },
]

/** Models attributed to the fabricated usage, with a rough request-share weight. */
export const DEMO_MODELS: { model: string; weight: number }[] = [
  { model: 'claude-opus-4-8', weight: 0.32 },
  { model: 'claude-sonnet-4-6', weight: 0.53 },
  { model: 'claude-haiku-4-5', weight: 0.15 },
]
