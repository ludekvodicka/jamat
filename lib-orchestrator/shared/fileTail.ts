import { open } from 'node:fs/promises'

/**
 * The last `maxBytes` of a file, with the truncated first line dropped whenever the read does not
 * start at zero: a caller that parses lines would otherwise take half a record for a whole one.
 *
 * It lives here because both readers that tail agent transcripts need exactly this bottom and
 * nothing else of each other; how far each of them walks back is its own discipline, so the ceiling
 * arrives as a parameter and this class owns no number.
 */
export class FileTail {
  static async read(file: string, size: number, maxBytes: number): Promise<string> {
    return (await FileTail.readBounded(file, size, maxBytes)).content
  }

  static async readBounded(
    file: string,
    size: number,
    maxBytes: number,
  ): Promise<{ content: string; bytesRead: number; startedAtFileBeginning: boolean }> {
    const length = Math.min(size, maxBytes)
    const start = Math.max(0, size - length)
    const handle = await open(file, 'r')
    try {
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, start)
      const content = buffer.toString('utf8', 0, bytesRead)
      if (start === 0)
        return { content, bytesRead, startedAtFileBeginning: true }
      const firstLine = content.indexOf('\n')
      return {
        content: firstLine < 0 ? '' : content.slice(firstLine + 1),
        bytesRead,
        startedAtFileBeginning: false,
      }
    }
    finally { await handle.close() }
  }
}
