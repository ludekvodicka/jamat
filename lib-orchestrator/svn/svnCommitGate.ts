export class SvnCommitGate {
  /** Every refusal line of the publication gate starts with it; other refusals (an unsupported path) do not. */
  static readonly refusedConst = 'Refused: '

  static readonly sidecarPattern = /\.(?:mine|working|r\d+|merge-(?:left|right)\.r\d+|prej)$|(?:^|\/)dir_conflicts(?:\.\d+)?\.prej$/

  static problems(input: { conflicted: readonly string[]; untracked: readonly string[]; markers: readonly string[] }): string[] {
    const problems = new Map<string, string>()
    for (const path of input.conflicted) problems.set(path, `${SvnCommitGate.refusedConst}${path} is conflicted`)
    for (const path of input.untracked)
      if (SvnCommitGate.sidecarPattern.test(path)) problems.set(path, `${SvnCommitGate.refusedConst}${path} is an svn conflict file`)
    for (const path of input.markers) if (!problems.has(path)) problems.set(path, `${SvnCommitGate.refusedConst}${path} contains svn conflict markers`)
    return [...problems.values()]
  }

  /** True when every line of a refusal is the gate's own: conflicted paths, conflict files or markers. */
  static isGateRefusal(detail: string): boolean {
    return detail.split('\n').every((line) => line.startsWith(SvnCommitGate.refusedConst))
  }

  static hasMarkerTriplet(text: string): boolean {
    return /^<<<<<<<[^\r\n]*(?:\r?\n)[\s\S]*?^=======[^\r\n]*(?:\r?\n)[\s\S]*?^>>>>>>>/m.test(text)
  }
}
