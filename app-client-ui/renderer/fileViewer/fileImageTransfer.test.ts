import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FileImageTransfer } from './fileImageTransfer'

describe('FileImageTransfer', () => {
  const drawImage = vi.fn()
  const writeImage = vi.fn()
  let loaded: { crossOrigin: string; src: string } | null

  beforeEach(() => {
    loaded = null
    drawImage.mockReset()
    writeImage.mockReset().mockResolvedValue({ ok: true, value: true })
    vi.stubGlobal('Image', class {
      crossOrigin = ''
      src = ''
      naturalWidth = 100
      naturalHeight = 50
      async decode(): Promise<void> { loaded = this }
    })
    vi.stubGlobal('appClient', { clipboard: { writeImage } })
    const create = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => tag !== 'canvas' ? create(tag)
      : Object.assign(create('canvas'), { getContext: () => ({ drawImage }), toDataURL: () => 'data:image/png;base64,PNG' })) as typeof document.createElement)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('draws the whole protocol image through CORS and writes it as a PNG', async () => {
    await FileImageTransfer.copy('jamat-v3-file://resource/picture')
    expect(loaded).toMatchObject({ crossOrigin: 'anonymous', src: 'jamat-v3-file://resource/picture' })
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 100, 50, 0, 0, 100, 50)
    expect(writeImage).toHaveBeenCalledExactlyOnceWith('data:image/png;base64,PNG')
  })

  it('crops an area to whole pixels inside the image', async () => {
    await FileImageTransfer.copy('data:image/png;base64,AA==', { x: 10.4, y: -5, width: 200, height: 20.2 })
    expect(loaded?.crossOrigin).toBe('')
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 10, 0, 90, 16, 0, 0, 90, 16)
  })

  it('fails when another application holds the clipboard', async () => {
    writeImage.mockResolvedValue({ ok: true, value: false })
    await expect(FileImageTransfer.copy('data:image/png;base64,AA==')).rejects.toThrow('Another application held the clipboard')
  })

  it('releases the loaded source after copying it', async () => {
    const release = vi.fn()
    await FileImageTransfer.copySource({ name: 'a.png', load: async () => ({ url: 'data:image/png;base64,AA==', release }) })
    expect(release).toHaveBeenCalledOnce()
  })

  it('reads the resource id only from a file protocol image', () => {
    const image = (src: string): HTMLImageElement => Object.assign(document.createElement('img'), { src })
    expect(FileImageTransfer.resourceId(image('jamat-v3-file://resource/a%20b'))).toBe('a b')
    expect(FileImageTransfer.resourceId(image('data:image/png;base64,AA=='))).toBeNull()
    expect(FileImageTransfer.resourceId(document.createElement('div'))).toBeNull()
  })
})
