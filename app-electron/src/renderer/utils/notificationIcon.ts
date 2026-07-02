// Per-type desktop-notification icons, drawn on an offscreen canvas and returned as PNG data URLs —
// no shipped image assets. Fills the toast's icon slot with a colored rounded square + a glyph so the
// user can tell at a glance what fired: a finished turn (✓), a question (?), a permission prompt (🔒),
// or a crash (✕). Colors mirror the tab status-dot palette (done / waiting / blocked) for consistency.

export type NotifKind = 'complete' | 'question' | 'permission' | 'crash'

const SPEC: Record<NotifKind, { bg: string; glyph: string; fg: string }> = {
  complete: { bg: '#26a69a', glyph: '✓', fg: '#ffffff' }, // teal — matches the 'done' status dot
  question: { bg: '#ffca28', glyph: '?', fg: '#1a1300' }, // amber — matches 'waiting'; dark glyph for contrast
  permission: { bg: '#ef5350', glyph: '🔒', fg: '#ffffff' }, // red — matches 'blocked'
  crash: { bg: '#ef5350', glyph: '✕', fg: '#ffffff' },
}

const cache = new Map<NotifKind, string>()

/**
 * Returns the notification icon for `kind` as a PNG data URL (cached per kind). Returns '' if the
 * canvas API is unavailable — callers then simply omit the icon and the OS shows the app default.
 */
export function notificationIcon(kind: NotifKind): string {
  const hit = cache.get(kind)
  if (hit !== undefined) return hit
  let url = ''
  try {
    const S = 96
    const canvas = document.createElement('canvas')
    canvas.width = S
    canvas.height = S
    const ctx = canvas.getContext('2d')
    if (ctx) {
      const { bg, glyph, fg } = SPEC[kind]
      const r = 20
      ctx.fillStyle = bg
      ctx.beginPath()
      ctx.moveTo(r, 0)
      ctx.arcTo(S, 0, S, S, r)
      ctx.arcTo(S, S, 0, S, r)
      ctx.arcTo(0, S, 0, 0, r)
      ctx.arcTo(0, 0, S, 0, r)
      ctx.closePath()
      ctx.fill()
      // Glyph (emoji like 🔒 ignore fillStyle and render in color — still legible on the tinted square).
      ctx.fillStyle = fg
      ctx.font = '700 56px "Segoe UI Symbol", "Segoe UI Emoji", "Segoe UI", sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(glyph, S / 2, S / 2 + 4)
      url = canvas.toDataURL('image/png')
    }
  } catch {
    /* canvas unavailable — omit icon */
  }
  cache.set(kind, url)
  return url
}
