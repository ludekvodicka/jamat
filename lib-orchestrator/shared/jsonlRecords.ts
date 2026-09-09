/**
 * A JSONL tail as records. Every transcript this tree reads is one JSON document per line, written
 * by somebody else and possibly cut mid-line by the tail that fetched it, so a line that will not
 * parse is left out rather than ending the read.
 *
 * Beside `fileTail.ts`, which is what produces the string it is given. The two readers over those
 * tails held byte-identical copies of this, and a change to one of them was a change to only one.
 */
export class JsonlRecords {
  static of(content: string): unknown[] {
    return content.split(/\r?\n/).flatMap((line) => {
      if (!line.trim()) return []
      try { return [JSON.parse(line) as unknown] }
      catch { return [] }
    })
  }
}
