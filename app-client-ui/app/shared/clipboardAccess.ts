import { clipboard, type NativeImage } from 'electron'

export type ClipboardImageRead =
  | { kind: 'none' }
  | { kind: 'image'; bytes: Uint8Array }
  | { kind: 'too-large' }

/**
 * The clipboard, written so that it actually lands.
 *
 * The Windows clipboard is one shared OS resource, and while another process holds it open - a
 * clipboard-history tool, `rdpclip` under Remote Desktop - `clipboard.writeText` silently does
 * nothing: Chromium neither retries nor reports it. So the write is read back and repeated until it
 * sticks. V1 measured that; here it is written once rather than in each of the two services that
 * copy something.
 *
 * It is the main process's clipboard on purpose. `navigator.clipboard` is gated on a secure origin
 * and on focus, so in the packaged `file://` renderer it rejects without a sound - working in
 * development and no-opping in a release, which is the worse of the two failures.
 */
export class ClipboardAccess {
  private static readonly attemptsConst = 8
  private static readonly backoffMillisecondsConst = 25
  private static readonly jpegQualityConst = 85
  private static readonly shrinkAttemptsConst = 4

  static readText(): string {
    return clipboard.readText()
  }

  /**
   * The file Explorer's Ctrl+C put on the clipboard, or null. Windows keeps it as `FileNameW`, a
   * UTF-16 path ending in NUL; of several copied files that format names the first only. Other
   * platforms answer an empty buffer.
   */
  static readFileDrop(): string | null {
    const path = clipboard.readBuffer('FileNameW').toString('utf16le').split('\0')[0]
    return path.length > 0 ? path : null
  }

  /**
   * The clipboard's image in at most `bytesMax` bytes: PNG where it fits, otherwise a JPEG made
   * smaller until it does. A screenshot is mostly flat colour and stays PNG; a photo or a 4K screen
   * would not cross the peer wire as one.
   */
  static readImage(bytesMax: number): ClipboardImageRead {
    const image = clipboard.readImage()
    if (image.isEmpty()) return { kind: 'none' }
    const png = image.toPNG()
    if (png.length <= bytesMax) return { kind: 'image', bytes: png }
    let current: NativeImage = image
    for (let attempt = 0; attempt < ClipboardAccess.shrinkAttemptsConst; attempt++) {
      const jpeg = current.toJPEG(ClipboardAccess.jpegQualityConst)
      if (jpeg.length <= bytesMax) return { kind: 'image', bytes: jpeg }
      const scale = Math.sqrt(bytesMax / jpeg.length) * 0.9
      current = current.resize({ width: Math.max(1, Math.floor(current.getSize().width * scale)), quality: 'better' })
    }
    return { kind: 'too-large' }
  }

  /** false = another process held the clipboard for the whole window and the text is not there. */
  static async writeText(text: string): Promise<boolean> {
    for (let attempt = 0; attempt < ClipboardAccess.attemptsConst; attempt++) {
      clipboard.writeText(text)
      if (clipboard.readText() === text) return true
      await new Promise((resolve) => setTimeout(resolve, ClipboardAccess.backoffMillisecondsConst))
    }
    return false
  }
}
