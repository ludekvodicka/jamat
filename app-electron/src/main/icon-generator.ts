import { nativeImage, NativeImage } from 'electron'
import { Resvg } from '@resvg/resvg-js'

// The app's brand icon (concept "J_" — a sky-blue J + a purple "waiting" cursor on a dark card),
// inlined as a PNG data URL so it renders identically in dev and in the packaged app with no
// file-path dependency. Source of truth: docs/images/logo/jamat-256.png.
const LOGO_PNG_BASE64 =
  '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'

// Default (no color) = the baked brand PNG. Per-group-color icons are generated from the brand
// geometry with a tinted card + a luminance-picked mono glyph. Cache keyed by color ('' = default).
const iconCache = new Map<string, NativeImage>()

/** Drop cached icons (callers refresh on theme / color changes). */
export function clearIconCache(): void {
  iconCache.clear()
}

/**
 * The window / taskbar icon. With no color → the fixed brand logo (default window). With a
 * window-group color → the card background is tinted with that color and the "J" + cursor are
 * drawn in a single high-contrast ink (white on dark tints, near-black on light ones) so the
 * glyph stays legible on every palette color, including same-hue groups.
 */
export function createWindowIcon(color?: string): NativeImage {
  const key = color || ''

  const cached = iconCache.get(key)
  if (cached) return cached

  const icon = key
    ? nativeImage.createFromBuffer(renderTintedIcon(key))
    : nativeImage.createFromDataURL(`data:image/png;base64,${LOGO_PNG_BASE64}`)

  iconCache.set(key, icon)
  return icon
}

// Brand icon geometry (viewBox 0 0 120 120): a rounded card, the "J" as two round-capped strokes,
// and the small "waiting cursor" block. Only the card fill + glyph ink change per group color.
function renderTintedIcon(color: string): Buffer {
  const bg = color.startsWith('#') ? color : `#${color}`
  const lightBg = relativeLuminance(bg) > 0.36
  const ink = lightBg ? '#0d1117' : '#ffffff'
  const border = lightBg ? 'rgba(0,0,0,0.30)' : 'rgba(255,255,255,0.16)'

  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="120" height="120">' +
    `<rect x="1" y="1" width="118" height="118" rx="26" fill="${bg}" stroke="${border}" stroke-width="2"/>` +
    `<path d="M 38 36 H 82" stroke="${ink}" stroke-width="12" stroke-linecap="round" fill="none"/>` +
    `<path d="M 70 36 V 72 Q 70 92 51 92 Q 37 92 35 78" stroke="${ink}" stroke-width="12" stroke-linecap="round" fill="none"/>` +
    `<rect x="80" y="82" width="16" height="12" rx="2" fill="${ink}"/>` +
    '</svg>'

  return new Resvg(svg, { fitTo: { mode: 'width', value: 256 } }).render().asPng()
}

// WCAG relative luminance of a #rrggbb color (0 = black … 1 = white).
function relativeLuminance(hex: string): number {
  const clean = hex.replace('#', '')
  const channel = (h: string): number => {
    const c = parseInt(h, 16) / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  const r = channel(clean.slice(0, 2))
  const g = channel(clean.slice(2, 4))
  const b = channel(clean.slice(4, 6))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
