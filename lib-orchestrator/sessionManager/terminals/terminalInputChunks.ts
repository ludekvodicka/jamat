/**
 * One string of terminal input, cut into pieces the wire will take.
 *
 * The Host refuses a `terminal.input` frame whose data is over `HostWireConst.maxInputBytes`, and it
 * refuses it as a `bad-request`, which is indistinguishable from a malformed attach. A 4 KB clipboard
 * pasted as one frame therefore did not paste: it lost the whole screen and left the session running
 * with nothing attached to it.
 *
 * The cut is by CODE POINT, never inside one. Each piece is then valid UTF-8 on its own, and the PTY
 * receives exactly the byte stream one write would have given it - which is what lets the bracketed
 * paste markers simply ride along inside the text: the first piece carries the opener, the last the
 * closer, and the shell reads one paste.
 */
export class TerminalInputChunks {
  /** The widest a single UTF-16 code unit gets in UTF-8. A surrogate PAIR is two units and 4 bytes. */
  private static readonly bytesPerUnitMaxConst = 3

  static of(data: string, bytesMax: number): readonly string[] {
    // Every keystroke comes through here, so the common case never walks the string.
    if (data.length * TerminalInputChunks.bytesPerUnitMaxConst <= bytesMax) return [data]
    const chunks: string[] = []
    let chunk = ''
    let bytes = 0
    for (const character of data) {
      const width = TerminalInputChunks.bytesOf(character)
      // An empty chunk takes the character whatever it weighs: a limit narrower than one code point
      // is not a reason to drop it, and splitting it would put half a character on the wire.
      if (bytes + width > bytesMax && chunk !== '') {
        chunks.push(chunk)
        chunk = ''
        bytes = 0
      }
      chunk += character
      bytes += width
    }
    if (chunk !== '') chunks.push(chunk)
    return chunks
  }

  /** `for...of` yields whole code points, so a surrogate here is the first half of a pair. */
  private static bytesOf(character: string): number {
    const code = character.charCodeAt(0)
    if (code < 0x80) return 1
    else if (code < 0x800) return 2
    else if (code < 0xd800 || code > 0xdfff) return 3
    else return 4
  }
}
