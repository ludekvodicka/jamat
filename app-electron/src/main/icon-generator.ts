import { nativeImage, NativeImage } from 'electron'
import { DEFAULT_STATUS_BAR_COLOR } from '../shared/window-colors'

const iconCache = new Map<string, NativeImage>()

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '')
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16)
  }
}

// 16x16 "J" letter bitmap — compact, centered (1 = white pixel, 0 = background)
const J_BITMAP_16 = [
  '0000000000000000',
  '0000000000000000',
  '0000000000000000',
  '0000000000000000',
  '0000011111100000',
  '0000000011000000',
  '0000000011000000',
  '0000000011000000',
  '0000000011000000',
  '0000000011000000',
  '0000010011000000',
  '0000011111000000',
  '0000000000000000',
  '0000000000000000',
  '0000000000000000',
  '0000000000000000',
]

function generateIcon(size: number, color: string): Buffer {
  const { r, g, b } = hexToRgb(color)
  const pixels = Buffer.alloc(size * size * 4)

  // Electron nativeImage raw buffer uses BGRA order on Windows
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4
      pixels[idx] = b
      pixels[idx + 1] = g
      pixels[idx + 2] = r
      pixels[idx + 3] = 255
    }
  }

  if (size === 16) {
    for (let y = 0; y < 16; y++) {
      const row = J_BITMAP_16[y]
      for (let x = 0; x < 16; x++) {
        if (row[x] === '1') {
          const idx = (y * 16 + x) * 4
          pixels[idx] = 255
          pixels[idx + 1] = 255
          pixels[idx + 2] = 255
          pixels[idx + 3] = 255
        }
      }
    }
  } else if (size === 32) {
    for (let y = 0; y < 16; y++) {
      const row = J_BITMAP_16[y]
      for (let x = 0; x < 16; x++) {
        if (row[x] === '1') {
          for (let dy = 0; dy < 2; dy++) {
            for (let dx = 0; dx < 2; dx++) {
              const px = x * 2 + dx
              const py = y * 2 + dy
              const idx = (py * 32 + px) * 4
              pixels[idx] = 255
              pixels[idx + 1] = 255
              pixels[idx + 2] = 255
              pixels[idx + 3] = 255
            }
          }
        }
      }
    }
  }

  return pixels
}


export function clearIconCache(): void {
  iconCache.clear()
}

export function createWindowIcon(color?: string): NativeImage {
  const c = color || DEFAULT_STATUS_BAR_COLOR

  const cached = iconCache.get(c)
  if (cached) return cached

  const size = 32
  const pixels = generateIcon(size, c)
  const icon = nativeImage.createFromBuffer(pixels, { width: size, height: size })

  iconCache.set(c, icon)
  return icon
}
