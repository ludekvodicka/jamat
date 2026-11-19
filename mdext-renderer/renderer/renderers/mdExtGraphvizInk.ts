type MdExtRgb = readonly [number, number, number]

interface MdExtGraphvizFill {
  left: number
  top: number
  right: number
  bottom: number
  rgb: MdExtRgb
}

/**
 * Labels Graphviz drew in the theme's default ink over a fill the source chose.
 *
 * The dark workspace gives every label a light ink, so a light `fillcolor` hid the text of its node.
 * Graphviz cannot pick a font colour by fill, so after layout a node or cluster label that still has
 * the default ink and too little contrast with the fill under it takes the ink that reads best there.
 * A font colour the source set stays.
 */
export class MdExtGraphvizInk {
  /** WCAG AA for normal text. */
  private static readonly minimumContrastConst = 4.5
  private static readonly candidateInksConst: readonly MdExtRgb[] = [[0x1f, 0x23, 0x28], [0xff, 0xff, 0xff]]
  private static readonly unparsedConst = '#010203'
  private static canvas: CanvasRenderingContext2D | null | undefined

  static apply(svg: string, ink: string): string {
    const inkRgb = MdExtGraphvizInk.rgb(ink)
    if (inkRgb === null) return svg
    const document = new DOMParser().parseFromString(svg, 'image/svg+xml')
    if (document.querySelector('parsererror')) return svg
    let changed = false
    for (const group of document.querySelectorAll('g[class~="node"], g[class~="cluster"]')) {
      // Document order is paint order: a table cell's fill comes after the node's and before its text.
      const fills: MdExtGraphvizFill[] = []
      for (const element of group.querySelectorAll('*')) {
        if (element.localName === 'text') {
          if (MdExtGraphvizInk.recolour(element, fills, inkRgb)) changed = true
          continue
        }
        const fill = MdExtGraphvizInk.fill(element)
        if (fill !== null) fills.push(fill)
      }
    }
    return changed ? new XMLSerializer().serializeToString(document.documentElement) : svg
  }

  private static recolour(text: Element, fills: readonly MdExtGraphvizFill[], ink: MdExtRgb): boolean {
    const own = MdExtGraphvizInk.rgb(text.getAttribute('fill') ?? '')
    if (own === null || own.some((channel, index) => channel !== ink[index])) return false
    const x = Number(text.getAttribute('x'))
    const y = Number(text.getAttribute('y'))
    const under = fills.findLast((fill) =>
      x >= fill.left && x <= fill.right && y >= fill.top && y <= fill.bottom)
    if (under === undefined) return false
    if (MdExtGraphvizInk.contrast(ink, under.rgb) >= MdExtGraphvizInk.minimumContrastConst) return false
    const best = MdExtGraphvizInk.candidateInksConst.reduce((kept, candidate) =>
      MdExtGraphvizInk.contrast(candidate, under.rgb) > MdExtGraphvizInk.contrast(kept, under.rgb) ? candidate : kept)
    text.setAttribute('fill', `#${best.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`)
    return true
  }

  /** A shape a label can sit on; a mostly transparent fill shows the page, not itself. */
  private static fill(element: Element): MdExtGraphvizFill | null {
    if (!['polygon', 'path', 'ellipse', 'polyline', 'rect'].includes(element.localName)) return null
    const opacity = Number(element.getAttribute('fill-opacity') ?? '1')
    if (opacity < 0.5) return null
    const rgb = MdExtGraphvizInk.rgb(element.getAttribute('fill') ?? '')
    if (rgb === null) return null
    const number = (name: string): number => Number(element.getAttribute(name) ?? '0')
    if (element.localName === 'ellipse') {
      const [cx, cy, rx, ry] = [number('cx'), number('cy'), number('rx'), number('ry')]
      return { left: cx - rx, top: cy - ry, right: cx + rx, bottom: cy + ry, rgb }
    }
    if (element.localName === 'rect') {
      const [x, y] = [number('x'), number('y')]
      return { left: x, top: y, right: x + number('width'), bottom: y + number('height'), rgb }
    }
    const geometry = element.getAttribute(element.localName === 'path' ? 'd' : 'points') ?? ''
    const values = (geometry.match(/-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? []).map(Number)
    if (values.length < 4) return null
    const xs = values.filter((_value, index) => index % 2 === 0)
    const ys = values.filter((_value, index) => index % 2 === 1)
    return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys), rgb }
  }

  /**
   * Graphviz writes a colour as `#rrggbb` or, when SVG knows the name, as that name. A name goes
   * through the canvas, the browser's own colour parser.
   */
  private static rgb(colour: string): MdExtRgb | null {
    const value = colour.trim().toLowerCase()
    if (value === '' || value === 'none' || value === 'transparent') return null
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(value)
    if (hex !== null) {
      const digits = hex[1]!.length === 3 ? [...hex[1]!].map((digit) => digit + digit).join('') : hex[1]!
      return [0, 2, 4].map((at) => parseInt(digits.slice(at, at + 2), 16)) as unknown as MdExtRgb
    }
    if (MdExtGraphvizInk.canvas === undefined)
      MdExtGraphvizInk.canvas = window.document.createElement('canvas').getContext('2d')
    const canvas = MdExtGraphvizInk.canvas
    if (canvas === null) return null
    canvas.fillStyle = MdExtGraphvizInk.unparsedConst
    canvas.fillStyle = value
    const parsed = String(canvas.fillStyle)
    if (parsed === MdExtGraphvizInk.unparsedConst) return null
    if (parsed.startsWith('#')) return MdExtGraphvizInk.rgb(parsed)
    const rgba = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(parsed)
    if (rgba === null || Number(rgba[4] ?? '1') < 0.5) return null
    return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])]
  }

  private static contrast(first: MdExtRgb, second: MdExtRgb): number {
    const [lighter, darker] = [MdExtGraphvizInk.luminance(first), MdExtGraphvizInk.luminance(second)]
      .sort((a, b) => b - a) as [number, number]
    return (lighter + 0.05) / (darker + 0.05)
  }

  private static luminance(rgb: MdExtRgb): number {
    const [r, g, b] = rgb.map((channel) => {
      const value = channel / 255
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    }) as [number, number, number]
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
}
