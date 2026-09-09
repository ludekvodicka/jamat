import type { NativeImage } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { WindowIcon } from './windowIcon'

const { iconMock, resvgMock } = vi.hoisted(() => ({
  iconMock: {
    dataUrls: [] as string[],
    buffers: [] as Buffer[],
    emptyNext: false,
  },
  resvgMock: {
    renders: [] as { svg: string; options: unknown }[],
  },
}))

vi.mock('electron', () => ({
  nativeImage: {
    createFromDataURL: (dataUrl: string) => {
      iconMock.dataUrls.push(dataUrl)
      const empty = iconMock.emptyNext
      iconMock.emptyNext = false
      return { source: dataUrl, isEmpty: () => empty } as unknown as NativeImage
    },
    createFromBuffer: (buffer: Buffer) => {
      iconMock.buffers.push(buffer)
      const empty = iconMock.emptyNext
      iconMock.emptyNext = false
      return { source: buffer, isEmpty: () => empty } as unknown as NativeImage
    },
  },
}))

vi.mock('@resvg/resvg-js', () => ({
  Resvg: class {
    constructor(private readonly svg: string, private readonly options: unknown) {}

    render(): { asPng(): Uint8Array } {
      resvgMock.renders.push({ svg: this.svg, options: this.options })
      return { asPng: () => Uint8Array.from([1, 2, 3]) }
    }
  },
}))

describe('app-client-ui/app/shell/windowIcon', () => {
  beforeEach(() => {
    WindowIcon.clearCache()
    iconMock.dataUrls.length = 0
    iconMock.buffers.length = 0
    iconMock.emptyNext = false
    resvgMock.renders.length = 0
  })

  it('returns and caches the inlined default brand icon', () => {
    const first = WindowIcon.of(null)
    const second = WindowIcon.of(null)

    expect(second).toBe(first)
    expect(iconMock.dataUrls).toHaveLength(1)
    expect(iconMock.dataUrls[0]).toMatch(/^data:image\/png;base64,/)
    expect(iconMock.dataUrls[0].length).toBeGreaterThan(8_000)
  })

  it('renders a 256 pixel tinted icon once per color', () => {
    const first = WindowIcon.of('#123456')
    const second = WindowIcon.of('#123456')

    expect(second).toBe(first)
    expect(resvgMock.renders).toHaveLength(1)
    expect(resvgMock.renders[0].svg).toContain('fill="#123456"')
    expect(resvgMock.renders[0].options).toEqual({ fitTo: { mode: 'width', value: 256 } })
  })

  it('uses dark ink above the luminance threshold and white ink below it', () => {
    WindowIcon.of('#ffffff')
    WindowIcon.of('#000000')

    expect(resvgMock.renders[0].svg).toContain('stroke="#0d1117"')
    expect(resvgMock.renders[1].svg).toContain('stroke="#ffffff"')
  })

  it('returns the default rather than a previous tint when color is cleared', () => {
    const tinted = WindowIcon.of('#123456')
    const cleared = WindowIcon.of(null)

    expect(cleared).not.toBe(tinted)
    expect(iconMock.dataUrls).toHaveLength(1)
  })

  it('refuses an empty native image instead of caching it', () => {
    iconMock.emptyNext = true

    expect(() => WindowIcon.of('#654321')).toThrow(/empty image/)
    expect(() => WindowIcon.of('#654321')).not.toThrow()
    expect(iconMock.buffers).toHaveLength(2)
  })
})
