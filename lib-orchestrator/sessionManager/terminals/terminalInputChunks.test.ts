import { describe, expect, it } from 'vitest'

import { TerminalInputChunks } from './terminalInputChunks'

function bytesOf(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

describe('lib-orchestrator/sessionManager/terminals/terminalInputChunks', () => {
  it('leaves a keystroke as the one chunk it already is', () => {
    expect(TerminalInputChunks.of('a', 4_096)).to.deep.equal(['a'])
  })

  it('leaves a string that fits alone', () => {
    const text = 'x'.repeat(4_096)
    expect(TerminalInputChunks.of(text, 4_096)).to.deep.equal([text])
  })

  it('splits the first string that does not', () => {
    const chunks = TerminalInputChunks.of('x'.repeat(4_097), 4_096)
    expect(chunks.length).to.equal(2)
    expect(chunks[0]).to.equal('x'.repeat(4_096))
    expect(chunks[1]).to.equal('x')
  })

  /**
   * The one thing a byte-counted split must never do. Half a code point on the wire is a byte
   * sequence the PTY decodes as a replacement character, so what arrives is not what was pasted.
   */
  it('never cuts a multi-byte character in half', () => {
    // 3 bytes each, so a limit of 10 takes three of them and leaves one byte over.
    const text = '┌'.repeat(8)
    const chunks = TerminalInputChunks.of(text, 10)
    expect(chunks.join('')).to.equal(text)
    for (const chunk of chunks) expect(bytesOf(chunk)).to.be.at.most(10)
    expect(chunks).to.deep.equal(['┌┌┌', '┌┌┌', '┌┌'])
  })

  it('counts a surrogate pair as the four bytes it weighs, not as two characters', () => {
    // Four 4-byte emoji: a limit of 8 takes exactly two per chunk.
    const chunks = TerminalInputChunks.of('😀😀😀😀', 8)
    expect(chunks).to.deep.equal(['😀😀', '😀😀'])
    for (const chunk of chunks) expect(bytesOf(chunk)).to.equal(8)
  })

  /** Dropping it or looping on it are the two ways this goes wrong; emitting it is neither. */
  it('emits a character wider than the whole limit rather than dropping it', () => {
    expect(TerminalInputChunks.of('😀', 2)).to.deep.equal(['😀'])
  })

  /**
   * What the paste itself is: the markers are text in the string, so the opener rides on the first
   * chunk and the closer on the last, and the shell reads one bracketed paste out of the sequence.
   */
  it('keeps the bracketed paste markers at the two ends', () => {
    const paste = `\x1b[200~${'y'.repeat(9_000)}\x1b[201~`
    const chunks = TerminalInputChunks.of(paste, 4_096)
    expect(chunks.join('')).to.equal(paste)
    expect(chunks[0].startsWith('\x1b[200~')).to.equal(true)
    expect(chunks[chunks.length - 1].endsWith('\x1b[201~')).to.equal(true)
    for (const chunk of chunks) expect(bytesOf(chunk)).to.be.at.most(4_096)
  })

  it('joins back into the input it was given', () => {
    const text = 'Řádek s háčky, box ┌──┐ a emoji 😀\r\n'.repeat(200)
    expect(TerminalInputChunks.of(text, 4_096).join('')).to.equal(text)
  })
})
