import type { SvnConflictOption, SvnConflictShape, SvnNodeKind } from '../../svn/svn.types'
import { SvnConflictShapes } from '../../svn/svnConflictShapes'
import type { SvnActionConflictEntry, SvnActionConflictSet, SvnActionFixed } from '../records/sessionRecord.types'
import type { SessionSvnConflictInfo, SessionSvnConflictOptionInfo } from '../sessionManagerApi.types'
import type { SvnGuardFinding } from './svnConflictGuard'

/**
 * The words of a conflict set: the summary, a description per path and the label and note of each
 * option, composed from the facts the record keeps, so no word lives in the record and every surface
 * reads the same sentence.
 */
export class SvnConflictWords {
  /** The paths a need's reason names; the rest is counted. */
  private static readonly listedPathsConst = 20

  /** "3 conflicts need you", "3 conflicts: Jamat fixed 1, merger on 2", "1 conflict needs you". */
  static summaryOf(set: SvnActionConflictSet): string {
    const total = set.entries.length + set.more
    const count = (predicate: (entry: SvnActionConflictEntry) => boolean): number => set.entries.filter(predicate).length
    const person = count((entry) => entry.state === 'person') + set.more
    if (person === total) return `${SvnConflictWords.conflicts(total)} ${total === 1 ? 'needs' : 'need'} you`
    const settledBy = (by: SvnActionConflictEntry['by']): number => count((entry) => entry.state === 'settled' && entry.by === by)
    const parts = [
      [count((entry) => entry.state === 'rule') + settledBy('jamat'), 'Jamat fixed'],
      [settledBy('agent'), 'merger fixed'],
      [settledBy('person'), 'you fixed'],
      [count((entry) => entry.state === 'agent'), 'merger on'],
    ] as const
    const words = parts.flatMap(([amount, word]) => amount === 0 ? [] : [`${word} ${amount}`])
    if (person > 0) words.push(`${person} ${person === 1 ? 'needs' : 'need'} you`)
    return `${SvnConflictWords.conflicts(total)}: ${words.join(', ')}`
  }

  /** An option as a step, a result line and a pass name it: "keep both", "take incoming". */
  static optionWordOf(option: SvnConflictOption): string {
    switch (option) {
      case 'merged': return 'merged'
      case 'take-incoming': return 'take incoming'
      case 'keep-mine': return 'keep mine'
      case 'keep-both': return 'keep both'
      case 'union': return 'union'
      default: throw new Error(`Unknown conflict option: ${JSON.stringify(option satisfies never)}`)
    }
  }

  /** The result lines of what Jamat's rules settled: one FIXED line per path, at most 20, then where the saved copies are. */
  static fixedLinesOf(fixed: readonly SvnActionFixed[], savedDir: string): string[] {
    if (fixed.length === 0) return []
    const shown = fixed.slice(0, SvnConflictWords.listedPathsConst)
    const rest = fixed.length - shown.length
    return [
      ...shown.map((fix) => `FIXED: ${fix.path} (${SvnConflictWords.optionWordOf(fix.option)})`),
      ...rest > 0 ? [`FIXED: ${rest} more; fixes.log beside the saved copies lists them`] : [],
      `   saved copies: ${savedDir}`,
    ]
  }

  /** The detail of a done check of the conflicts: "Jamat fixed 1 of 3 conflicts", "2 conflicts left". */
  static fixingOf(facts: { conflicts?: number; fixed?: number; left?: number }): string {
    const fixed = facts.fixed ?? 0
    const left = facts.left ?? 0
    if (fixed > 0) return `Jamat fixed ${fixed} of ${SvnConflictWords.conflicts(facts.conflicts ?? fixed + left)}`
    return left > 0 ? `${SvnConflictWords.conflicts(left)} left` : 'no conflict left'
  }

  /** The reason a waiting action names: the summary and the paths, at most 20 of them. */
  static reasonOf(set: SvnActionConflictSet, again: string): string {
    const paths = set.entries.map((entry) => entry.kind === 'text' ? entry.path : `${entry.path} (${entry.kind})`)
    const shown = paths.slice(0, SvnConflictWords.listedPathsConst)
    const rest = paths.length - shown.length + set.more
    return `${SvnConflictWords.summaryOf(set)}: ${shown.join(', ')}${rest > 0 ? ` and ${rest} more` : ''}; settle them, then ${again}`
  }

  /** Why the guards reopened paths after a settlement, one clause per finding. */
  static guardOf(findings: readonly SvnGuardFinding[]): string {
    return findings.map((finding) => {
      const kind = finding.kind
      switch (kind) {
        case 'still-marked': return `svn still marks ${finding.path} as conflicted`
        case 'markers': return `${finding.path} still holds conflict markers`
        case 'drops-incoming':
          return `the commit would drop what ${finding.revision === null ? 'the other commit' : `r${finding.revision}`} brought in below ${finding.path}`
        case 'outside-set': {
          const shown = finding.paths.slice(0, SvnConflictWords.listedPathsConst)
          const rest = finding.paths.length - shown.length
          return `changed outside the conflicts while the merger ran: ${shown.join(', ')}${rest > 0 ? ` and ${rest} more` : ''}`
        }
        case 'committed': return `a commit was made from the worktree while the merger ran (r${finding.revision})`
        default: throw new Error(`Unknown guard finding: ${JSON.stringify(kind satisfies never)}`)
      }
    }).join('; ')
  }

  /** The first `max` entries in the wire's words, and how many more the set holds. */
  static listOf(set: SvnActionConflictSet, max: number): { entries: SessionSvnConflictInfo[]; more: number } {
    const shown = set.entries.slice(0, max)
    return { entries: shown.map(SvnConflictWords.infoOf), more: set.entries.length - shown.length + set.more }
  }

  static infoOf(entry: SvnActionConflictEntry): SessionSvnConflictInfo {
    return {
      path: entry.path,
      kind: entry.kind,
      state: entry.state,
      description: SvnConflictWords.descriptionOf(entry),
      by: entry.by ?? null,
      saved: entry.saved ?? null,
      options: entry.options.map((option) => SvnConflictWords.optionOf(entry, option)),
    }
  }

  /** One sentence from the facts: what the session did, what the other commit did. */
  static descriptionOf(entry: SvnActionConflictEntry): string {
    const facts = entry.facts
    const revision = SvnConflictWords.revisionOf(entry)
    const node = SvnConflictWords.nodeOf(facts.localKind ?? facts.incomingKind)
    const properties = (facts.properties ?? []).join(', ')
    const shape: SvnConflictShape = entry.shape
    switch (shape) {
      case 'text-overlap': return `Your session and ${revision} changed the same lines of this file.`
      case 'text-same': return `Your session and ${revision} wrote the same text; only the line ends differ.`
      case 'binary': return `Your session and ${revision} both changed this binary file.`
      case 'text-unreadable': return `Your session and ${revision} both changed this file, which is not UTF-8 text.`
      case 'name-unsafe': return 'svn cannot take this name as an argument, so Jamat writes nothing for it; resolve it in an SVN client such as TortoiseSVN, then check again.'
      case 'mergeinfo': return `Your session and ${revision} both changed svn:mergeinfo.`
      case 'line-list-property': case 'property-value':
        return properties === '' ? `Your session and ${revision} set the same property values.` : `Your session and ${revision} both changed ${properties}.`
      case 'externals': return `Your session and ${revision} both changed svn:externals${properties.includes(',') ? ` (with ${properties})` : ''}.`
      case 'obstructed-dir': {
        const files = facts.files
        if (files === undefined) return `Your session added this folder; ${revision} added it too.`
        const differing = files.differing === 0 ? '' : ` ${SvnConflictWords.files(files.differing)} with the same name ${files.differing === 1 ? 'differs' : 'differ'}.`
        return `Your session added this folder with ${SvnConflictWords.files(files.local)}; ${revision} added it with ${SvnConflictWords.files(files.incoming)}.${differing}`
      }
      case 'obstructed-file': return `Your session added this file; ${revision} added it too.`
      case 'added-both': return `Your session and ${revision} both added this ${node}.`
      case 'kind-mismatch':
        return `Your session has a ${SvnConflictWords.nodeOf(facts.localKind)} here; ${revision} added a ${SvnConflictWords.nodeOf(facts.incomingKind)}.`
      case 'edit-vs-delete': return `Your session changed this ${node}; ${revision} deleted it.`
      case 'edit-vs-replace': return `Your session changed this ${node}; ${revision} replaced it.`
      case 'delete-vs-edit': return `Your session ${SvnConflictWords.removedOf(entry)} this ${node}; ${revision} changed it.`
      case 'delete-vs-delete': return `Your session and ${revision} both deleted this ${node}.`
      case 'replace-or-case': return `Your session replaced this ${node}; ${revision} changed it.`
      case 'diverged': return `A file of the same name differs between your session and ${revision}.`
      case 'drops-incoming':
        return facts.dropped === undefined || facts.dropped === 0
          ? `The commit would drop what ${revision} brought in.`
          : `The commit would delete ${SvnConflictWords.files(facts.dropped)} ${revision} ${SvnConflictWords.broughtOf(entry)}.`
      case 'unrecognized': return 'svn reports a conflict Jamat does not know; resolve it in an SVN client, then check again.'
      default: throw new Error(`Unknown conflict shape: ${JSON.stringify(shape satisfies never)}`)
    }
  }

  private static optionOf(entry: SvnActionConflictEntry, id: SvnConflictOption): SessionSvnConflictOptionInfo {
    const revision = SvnConflictWords.revisionOf(entry)
    const folder = entry.facts.incomingKind === 'dir' && entry.kind === 'tree'
    let label: string
    let note: string
    switch (id) {
      case 'merged':
        label = 'Merge'
        note = entry.kind === 'property' ? 'set the merged value; then it is marked resolved'
          : entry.kind === 'tree' ? 'combine both sides by hand; then it is marked resolved'
          : 'edit the file to the merged text; then it is marked resolved'
        break
      case 'take-incoming':
        label = 'Take incoming'
        if (folder) note = `restores what ${revision} added; the session's files are saved first, then removed`
        else if (entry.shape === 'text-same') note = `takes the version of ${revision}, which keeps its svn:eol-style; the session's version differed only in line ends`
        else note = `takes the version of ${revision}; the session's version is saved first`
        break
      case 'keep-mine':
        label = 'Keep mine'
        note = entry.kind === 'tree' && entry.facts.action === 'added'
          ? `keeps the session's version; the commit would delete ${SvnConflictWords.addedOf(entry, folder)} ${revision} added`
          : `keeps the session's version; what ${revision} brought is dropped`
        break
      case 'keep-both':
        label = 'Keep both'
        note = folder ? `restores the files ${revision} added and keeps the session's files beside them`
          : `keeps the session's ${SvnConflictWords.nodeOf(entry.facts.localKind)} beside the one ${revision} added`
        break
      case 'union':
        label = 'Union'
        note = entry.shape === 'mergeinfo' ? 'keeps the merged revision ranges of both sides'
          : `keeps the lines of ${revision}, adds the lines the session added and leaves out the ones it removed`
        break
      default: throw new Error(`Unknown conflict option: ${JSON.stringify(id satisfies never)}`)
    }
    return { id, label, note, loses: SvnConflictShapes.lossOf(id) }
  }

  /** What the other commit did to the files a guard found dropped. */
  private static broughtOf(entry: SvnActionConflictEntry): string {
    const action = entry.facts.action
    return action === 'edited' ? 'changed' : action === 'replaced' ? 'replaced' : action === 'added' ? 'added' : 'brought in'
  }

  /** What an incoming add brought: "the 3 files", "the files" of a folder not counted, "the file". */
  private static addedOf(entry: SvnActionConflictEntry, folder: boolean): string {
    if (!folder) return 'the file'
    const incoming = entry.facts.files?.incoming
    return incoming === undefined ? 'the files' : `the ${SvnConflictWords.files(incoming)}`
  }

  private static revisionOf(entry: SvnActionConflictEntry): string {
    const revision = entry.facts.incomingRevision
    return revision === undefined ? 'the other commit' : `r${revision}`
  }

  private static removedOf(entry: SvnActionConflictEntry): string {
    const reason = entry.facts.reason
    return reason === 'moved-away' ? 'moved away' : reason === 'missing' ? 'deleted from disk' : 'deleted'
  }

  private static nodeOf(kind: SvnNodeKind | undefined): string {
    return kind === 'dir' ? 'folder' : kind === 'file' ? 'file' : 'item'
  }

  private static conflicts(count: number): string {
    return `${count} conflict${count === 1 ? '' : 's'}`
  }

  private static files(count: number): string {
    return `${count} file${count === 1 ? '' : 's'}`
  }
}
