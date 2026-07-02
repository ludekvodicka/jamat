/**
 * Tab "instance id" — a stable, copyable handle for one tab, addressable across machines.
 *
 * Format: `<machine>:<folder>-<rand>` — e.g. `pc1:jamat-a1b2`.
 *   - `<machine>` = the owning machine's `selfName` (the name OTHER machines gave it in their peers
 *     list, so the id resolves there). Lowercase, no `:`.
 *   - `<folder>-<rand>` = a per-tab token: a readable folder slug + short random suffix.
 *
 * Pure (no electron/fs/crypto) — the renderer mints the token (it has the folder + can make the
 * random suffix), and both sides parse. Kept in `core/` so it's shared by the main resolver, the
 * CLI `ask`, and the renderer without duplicating the grammar.
 */

/** Charset for the whole id: machine (no `:`), then `:`, then the tab token. */
const INSTANCE_ID_RE = /^([a-z0-9][a-z0-9_.-]{0,63}):([A-Za-z0-9][A-Za-z0-9_.-]{0,127})$/

export interface ParsedInstanceId {
  /** The `<machine>` prefix (a peer name, or this machine's selfName). */
  machine: string
  /** The per-tab token after the first `:` (folder slug + random suffix). */
  token: string
}

/** Slugify a folder name into the readable part of a tab token (safe charset, capped). */
export function slugifyFolder(folder: string): string {
  const s = (folder || 'tab').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
  return s || 'tab'
}

/** Compose an instance id from a machine name, folder, and an already-generated random suffix. */
export function formatInstanceId(machine: string, folder: string, rand: string): string {
  const m = (machine || 'local').toLowerCase().replace(/[^a-z0-9_.-]+/g, '')
  return `${m || 'local'}:${slugifyFolder(folder)}-${rand}`
}

/** Parse an instance id into its machine + token parts, or null if malformed. */
export function parseInstanceId(id: unknown): ParsedInstanceId | null {
  if (typeof id !== 'string') return null
  const m = INSTANCE_ID_RE.exec(id.trim())
  if (!m) return null
  return { machine: m[1], token: m[2] }
}

/** True iff `id` is a syntactically valid instance id. */
export function isInstanceId(id: unknown): boolean {
  return parseInstanceId(id) !== null
}
