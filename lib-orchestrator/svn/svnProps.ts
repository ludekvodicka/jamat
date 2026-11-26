type Skel = Uint8Array | Skel[]

/**
 * The properties of one node as `wc.db` stores them: a skel list `(name length value ...)` whose
 * atoms are either implicit (a word) or explicit (a byte count, one space, then that many bytes).
 */
export class SvnProps {
  static readonly emptyConst = new SvnProps(new Map())
  private static readonly decoder = new TextDecoder()

  private readonly values: ReadonlyMap<string, string>

  private constructor(values: ReadonlyMap<string, string>) {
    this.values = values
  }

  static parseSkel(blob: Uint8Array | null): SvnProps {
    if (blob === null || blob.length === 0) return SvnProps.emptyConst
    return SvnProps.ofList(SvnProps.parse(blob))
  }

  /** `NODES.inherited_props` of a working-copy root: `(path (props) path (props) ...)`, every property list it holds. */
  static parseInheritedSkel(blob: Uint8Array | null): SvnProps[] {
    if (blob === null || blob.length === 0) return []
    const skel = SvnProps.parse(blob)
    if (!Array.isArray(skel)) throw new Error('inherited properties are not a list')
    return skel.filter((item): item is Skel[] => Array.isArray(item)).map((list) => SvnProps.ofList(list))
  }

  get(name: string): string | undefined {
    return this.values.get(name)
  }

  private static ofList(skel: Skel): SvnProps {
    if (!Array.isArray(skel) || skel.length % 2 !== 0) throw new Error('properties are not a list of name and value pairs')
    const values = new Map<string, string>()
    for (let index = 0; index < skel.length; index += 2) {
      const name = skel[index]!, value = skel[index + 1]!
      if (Array.isArray(name) || Array.isArray(value)) throw new Error('a property name or value is a list')
      values.set(SvnProps.decoder.decode(name), SvnProps.decoder.decode(value))
    }
    return new SvnProps(values)
  }

  private static parse(blob: Uint8Array): Skel {
    let at = 0
    const space = (byte: number) => byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09 || byte === 0x0c
    const skipSpace = () => { while (at < blob.length && space(blob[at]!)) at++ }
    const item = (): Skel => {
      skipSpace()
      if (at >= blob.length) throw new Error('skel ends early')
      const first = blob[at]!
      if (first === 0x28) {
        at++
        const list: Skel[] = []
        for (skipSpace(); blob[at] !== 0x29; skipSpace()) {
          if (at >= blob.length) throw new Error('skel list is not closed')
          list.push(item())
        }
        at++
        return list
      }
      if (first >= 0x30 && first <= 0x39) {
        let length = 0
        while (at < blob.length && blob[at]! >= 0x30 && blob[at]! <= 0x39) length = length * 10 + blob[at++]! - 0x30
        if (!space(blob[at] ?? 0)) throw new Error('explicit skel atom without its separator')
        const start = at + 1
        if (start + length > blob.length) throw new Error('explicit skel atom runs past the end')
        at = start + length
        return blob.subarray(start, at)
      }
      const start = at
      while (at < blob.length && !space(blob[at]!) && blob[at] !== 0x28 && blob[at] !== 0x29) at++
      return blob.subarray(start, at)
    }
    const skel = item()
    skipSpace()
    if (at !== blob.length) throw new Error('bytes after the skel')
    return skel
  }
}
