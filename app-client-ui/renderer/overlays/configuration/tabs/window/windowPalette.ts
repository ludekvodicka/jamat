import { WindowAppearanceLimits } from '../../../../../shared/windowInfo'

export interface WindowPaletteEntry {
  name: string
  color: string | null
}

export class WindowPalette {
  private static readonly entriesConst = [
    { name: 'Red', token: '--window-color-red' },
    { name: 'Orange', token: '--window-color-orange' },
    { name: 'Amber', token: '--window-color-amber' },
    { name: 'Green', token: '--window-color-green' },
    { name: 'Teal', token: '--window-color-teal' },
    { name: 'Cyan', token: '--window-color-cyan' },
    { name: 'Sky', token: '--window-color-sky' },
    { name: 'Blue', token: '--window-color-blue' },
    { name: 'Indigo', token: '--window-color-indigo' },
    { name: 'Violet', token: '--window-color-violet' },
    { name: 'Magenta', token: '--window-color-magenta' },
    { name: 'Rose', token: '--window-color-rose' },
  ] as const

  static read(): readonly WindowPaletteEntry[] {
    const styles = getComputedStyle(document.documentElement)
    return [
      { name: 'None', color: null },
      ...WindowPalette.entriesConst.map((entry) => {
        const color = styles.getPropertyValue(entry.token).trim().toLowerCase()
        if (!WindowAppearanceLimits.colorPattern.test(color))
          throw new Error(`Window palette token is missing or invalid: ${entry.token}`)
        return { name: entry.name, color }
      }),
    ]
  }
}
