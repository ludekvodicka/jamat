import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

export type AppGroupKind = 'collection' | 'product'
export type AppGroupRead =
  | { ok: true; kind: AppGroupKind | null }
  | { ok: false; detail: string }
export type AppGroupScope =
  | { ok: true; ownerDir: string | null; setupScope: 'project' | 'members' }
  | { ok: false; detail: string }

/**
 * Marker presence identifies a container of projects. Only an explicit product grants a shared
 * worktree scope; an empty legacy marker is a collection. Catalog presentation is independent.
 */
export class ProductGroup {
  static readonly markerConst = '.appgroup'

  /** Marker-presence lookup retained for callers that only need the container boundary. */
  static rootOf(dir: string): string | null {
    for (let current = resolve(dir); ; current = dirname(current)) {
      if (existsSync(join(current, ProductGroup.markerConst))) return current
      if (dirname(current) === current) return null
    }
  }

  static readAt(dir: string): AppGroupRead {
    const path = join(dir, ProductGroup.markerConst)
    let text: string
    try {
      text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '').trim()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, kind: null }
      return { ok: false, detail: `Cannot read ${path}: ${String(error)}` }
    }
    if (text === '') return { ok: true, kind: 'collection' }
    try {
      const value: unknown = JSON.parse(text)
      if (value !== null && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).length === 1 && 'kind' in value
        && (value.kind === 'collection' || value.kind === 'product'))
        return { ok: true, kind: value.kind }
    } catch {
      return { ok: false, detail: `${path} is not valid JSON; expected {"kind":"collection"} or {"kind":"product"}` }
    }
    return { ok: false, detail: `${path} must contain only kind: "collection" or "product"` }
  }

  static scopeOf(dir: string): AppGroupScope {
    const target = resolve(dir)
    for (let current = target; ; current = dirname(current)) {
      const group = ProductGroup.readAt(current)
      if (!group.ok) return group
      if (group.kind === 'product') return { ok: true, ownerDir: current, setupScope: 'members' }
      else if (group.kind === 'collection') {
        const member = relative(current, target).split(sep)[0]
        if (!member || member.startsWith('.') || member === 'components' || member === 'node_modules')
          return { ok: false, detail: `${current} is a collection of independent projects; choose a member project for the worktree` }
        return { ok: true, ownerDir: join(current, member), setupScope: 'project' }
      } else if (group.kind !== null) throw new Error(`Unknown group kind: ${group.kind satisfies never}`)
      if (dirname(current) === current) return { ok: true, ownerDir: null, setupScope: 'project' }
    }
  }
}
