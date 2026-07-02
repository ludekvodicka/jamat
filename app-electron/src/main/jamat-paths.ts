/**
 * Process-wide singleton holding the resolved `JamatPaths` map. Set ONCE in `bootstrap-userdata`
 * (the first import, before any module reads a data path at import time — e.g. `loadAppState()`),
 * then read everywhere via `getJamatPaths()`. A standalone module (no deps beyond the type) so it
 * can't create an import cycle with `ipc-windows`/`app-state-store`.
 */
import type { JamatPaths } from '../../../core/jamat-paths.js'

let paths: JamatPaths | null = null

export function setJamatPaths(p: JamatPaths): void { paths = p }

export function getJamatPaths(): JamatPaths {
  if (!paths) throw new Error('JamatPaths not initialized — bootstrap-userdata must run first')
  return paths
}
