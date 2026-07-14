/**
 * The ONE version comparator. Jamat carries two version schemes on purpose:
 *  - `datestamp` — root `package.json` `YYYY.MM.DD.HH.mm` (bumped by `npm run bump`; drives the
 *    launcher's recompile-on-change and the source channel's disk-vs-running compare).
 *  - `semver` — `app-electron/package.json` (= the release tag = the electron-updater feed).
 *
 * They must NEVER be compared with each other: a datestamp's first part (2026) outranks any semver
 * major, so a cross-scheme compare silently reports "newer" forever (that exact bug used to make a
 * packaged install prompt for an update in an endless loop). `compareVersions` therefore THROWS on a
 * scheme mismatch — loud failure instead of a silent wrong answer.
 *
 * Pure, no electron. Replaces `compareVersion` (update-checker) + `isNewer` (self-update) and both
 * copies of `readDiskVersion`.
 */
import { readFileSync } from 'node:fs'

export type VersionScheme = 'datestamp' | 'semver'

export interface ParsedVersion {
  raw: string
  scheme: VersionScheme
  parts: number[]
}

/** A leading part ≥ 1900 can only be a year — nothing else distinguishes `2026.7.14` from a semver. */
const DATESTAMP_MIN_YEAR = 1900

export function parseVersion(raw: string): ParsedVersion {
  const parts = raw.trim().split('.').map((p) => parseInt(p, 10))
  if (parts.length === 0 || parts.some((n) => !Number.isFinite(n)))
    throw new Error(`Unparseable version: ${JSON.stringify(raw)}`)
  return { raw, scheme: parts[0] >= DATESTAMP_MIN_YEAR ? 'datestamp' : 'semver', parts }
}

/** >0 ⇒ `a` is newer. Throws when the schemes differ — see the file header. */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.scheme !== b.scheme)
    throw new Error(`Refusing to compare a ${a.scheme} to a ${b.scheme} version (${a.raw} vs ${b.raw})`)
  const len = Math.max(a.parts.length, b.parts.length)
  for (let i = 0; i < len; i++) {
    const d = (a.parts[i] ?? 0) - (b.parts[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

export function isNewerVersion(a: string, b: string): boolean {
  return compareVersions(parseVersion(a), parseVersion(b)) > 0
}

/** The one fresh read of a `package.json` version. null = missing / unreadable / no version field. */
export function readPackageVersion(packageJsonPath: string): string | null {
  try {
    const v = (JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { version?: unknown }).version
    return typeof v === 'string' && v.trim() ? v.trim() : null
  } catch {
    return null
  }
}
