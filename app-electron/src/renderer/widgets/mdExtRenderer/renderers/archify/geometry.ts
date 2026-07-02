/* Vendored from archify — github.com/tt-a1i/archify, MIT (renderers/shared/geometry.mjs).
 * Pure geometry helpers; no Node/DOM deps. Decoupled from archify's fs CLI for browser use.
 * See ./LICENSE. */
/* eslint-disable @typescript-eslint/no-explicit-any */

export type Point = [number, number]
export interface Rect {
  x: number
  y: number
  width: number
  height: number
  cx: number
  cy: number
}

export function asArray<T = any>(value: any): T[] {
  return Array.isArray(value) ? value : []
}

export function isFinitePoint(...coords: number[]): boolean {
  return coords.every((c) => Number.isFinite(c))
}

type RectLike = { x: number; y: number; width: number; height: number }
export function rectsOverlap(a: RectLike, b: RectLike, gap = 0): boolean {
  return !(
    a.x + a.width + gap <= b.x ||
    b.x + b.width + gap <= a.x ||
    a.y + a.height + gap <= b.y ||
    b.y + b.height + gap <= a.y
  )
}

export function anchor(rect: Rect, side: string): Point {
  switch (side) {
    case 'left':
      return [rect.x, rect.cy]
    case 'right':
      return [rect.x + rect.width, rect.cy]
    case 'top':
      return [rect.cx, rect.y]
    case 'bottom':
      return [rect.cx, rect.y + rect.height]
    default:
      return [rect.x + rect.width, rect.cy]
  }
}

export function defaultFromSide(from: Rect, to: Rect): string {
  if (to.cx < from.cx) return 'left'
  if (to.cx > from.cx) return 'right'
  if (to.cy > from.cy) return 'bottom'
  return 'top'
}

export function defaultToSide(from: Rect, to: Rect): string {
  if (to.cx < from.cx) return 'right'
  if (to.cx > from.cx) return 'left'
  if (to.cy > from.cy) return 'top'
  return 'bottom'
}

export function chosenSide(side: string | undefined, fallback: string): string {
  return side && side !== 'auto' ? side : fallback
}

export function polylinePath(points: Point[]): string {
  return points.map(([x, y], index) => `${index === 0 ? 'M' : 'L'} ${x} ${y}`).join(' ')
}

export function roundedPath(points: Point[], radius: number): string {
  if (points.length < 3 || radius <= 0) {
    return polylinePath(points)
  }
  const commands = [`M ${points[0][0]} ${points[0][1]}`]
  for (let i = 1; i < points.length - 1; i += 1) {
    const [px, py] = points[i - 1]
    const [cx, cy] = points[i]
    const [nx, ny] = points[i + 1]
    const prevLen = Math.hypot(cx - px, cy - py)
    const nextLen = Math.hypot(nx - cx, ny - cy)
    const r = Math.min(radius, prevLen / 2, nextLen / 2)
    if (r < 1) {
      commands.push(`L ${cx} ${cy}`)
      continue
    }
    const before = [cx - ((cx - px) / prevLen) * r, cy - ((cy - py) / prevLen) * r]
    const after = [cx + ((nx - cx) / nextLen) * r, cy + ((ny - cy) / nextLen) * r]
    commands.push(`L ${before[0]} ${before[1]}`)
    commands.push(`Q ${cx} ${cy} ${after[0]} ${after[1]}`)
  }
  const [endX, endY] = points[points.length - 1]
  commands.push(`L ${endX} ${endY}`)
  return commands.join(' ')
}

export function labelPoint(item: any, points: Point[]): Point {
  if (item.labelAt) return item.labelAt
  if (points.length === 2) {
    return [
      (points[0][0] + points[1][0]) / 2 + (item.labelDx || 0),
      points[0][1] - 10 + (item.labelDy || 0),
    ]
  }
  const segmentIndex = Math.min(points.length - 2, Math.max(0, item.labelSegment ?? 1))
  const a = points[segmentIndex]
  const b = points[segmentIndex + 1]
  return [(a[0] + b[0]) / 2 + (item.labelDx || 0), (a[1] + b[1]) / 2 - 10 + (item.labelDy || 0)]
}

export const componentFill: Record<string, string> = {
  frontend: 'c-frontend',
  backend: 'c-backend',
  database: 'c-database',
  cloud: 'c-cloud',
  security: 'c-security',
  messagebus: 'c-messagebus',
  external: 'c-external',
}

export const componentText: Record<string, string> = {
  frontend: 't-frontend',
  backend: 't-backend',
  database: 't-database',
  cloud: 't-cloud',
  security: 't-security',
  messagebus: 't-messagebus',
  external: 't-external',
}

export const arrowClassMap: Record<string, [string, string]> = {
  default: ['a-default', 'arrowhead'],
  emphasis: ['a-emphasis', 'arrowhead-emphasis'],
  security: ['a-security', 'arrowhead-security'],
  dashed: ['a-dashed', 'arrowhead-dashed'],
}

export function variantAccent(variant: string | undefined, { dashed = 't-messagebus' }: { dashed?: string } = {}): string {
  return variant === 'security'
    ? 't-security'
    : variant === 'emphasis'
      ? 't-backend'
      : variant === 'dashed'
        ? dashed
        : 't-muted'
}
