import type { SvnConflictOption, SvnConflictShape, SvnNodeKind } from '../../svn/svn.types'
import { SvnConflictShapes } from '../../svn/svnConflictShapes'
import type { SvnActionConflictEntry, SvnActionConflictSet, SvnActionFixed } from '../../sessionManager/worktreeSessionRecords'
import type { SvnConflictActor } from '../worktreeContracts'
import type { SessionSvnConflictInfo, SessionSvnConflictOptionInfo } from '../../sessionManager/sessionManagerApi.types'
import type { SvnGuardFinding } from './svnConflictGuard'

/**
 * Whose work the local side of a conflict is: a session's in its worktree, or the person's own in a
 * main copy that an UPDATE brings revisions into (UA1-J09-11).
 */
export type SvnConflictSide = 'worktree' | 'main-copy'

/**
 * The words of a conflict set: the summary, a description per path and the label and note of each
 * option, composed from the facts the record keeps, so no word lives in the record and every surface
 * reads the same sentence.
 */
export class SvnConflictWords {
  static open(set: SvnActionConflictSet | undefined): set is SvnActionConflictSet {
    return set !== undefined && set.entries.length + set.more > 0
  }

  /** The paths a need's reason names; the rest is counted. */
  private static readonly listedPathsConst = 20
  /** The fixes a done step's one line names; the conflict list under it holds them all. */
  private static readonly fixedShownConst = 3

  /** The label of the press that reads the conflicts again while one is open; every reason asking for it names this. */
  static readonly checkAgainConst = 'Check again'
  /** The label of the press that goes on from a waiting main-copy UPDATE. */
  static readonly updateConst = 'Update'

  /** "3 conflicts need you", "3 conflicts: Jamat fixed 1, merger on 2", "1 conflict needs you". */
  static summaryOf(set: SvnActionConflictSet): string {
    const total = set.entries.length + set.more
    const count = (predicate: (entry: SvnActionConflictEntry) => boolean): number => set.entries.filter(predicate).length
    const person = count((entry) => entry.state === 'person') + set.more
    if (person === total) return `${SvnConflictWords.conflicts(total)} ${total === 1 ? 'needs' : 'need'} you`
    const settledBy = (by: SvnActionConflictEntry['by']): number => count((entry) => entry.state === 'settled' && entry.by === by)
    const parts = [
      [count((entry) => entry.state === 'rule') + settledBy('jamat'), 'Jamat fixed'],
      [settledBy('agent'), 'worker fixed'],
      [settledBy('merger'), 'merger fixed'],
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

  /**
   * The detail of a done check of a settled set: the summary, then what each of Jamat's own rules kept
   * and where it saved the session's side: "1 conflict: Jamat fixed 1; .aidocs (keep both), saved copy: <path>".
   */
  static settledDetailOf(set: SvnActionConflictSet): string {
    const fixed = set.entries.filter((entry) => entry.state === 'settled' && entry.by === 'jamat' && entry.settledWith !== undefined)
    const shown = fixed.slice(0, SvnConflictWords.fixedShownConst)
    const rest = fixed.length - shown.length
    return [
      SvnConflictWords.summaryOf(set),
      ...shown.map((entry) => `${entry.path} (${SvnConflictWords.optionWordOf(entry.settledWith!)})${entry.saved === undefined ? '' : `, saved copy: ${entry.saved}`}`),
      ...rest > 0 ? [`${rest} more in the conflict list`] : [],
    ].join('; ')
  }

  /** The reason a waiting action names: the summary and the open paths, at most 20 of them. */
  static reasonOf(set: SvnActionConflictSet, again: string): string {
    const paths = set.entries.filter((entry) => entry.state !== 'settled')
      .map((entry) => entry.kind === 'text' ? entry.path : `${entry.path} (${entry.kind})`)
    const shown = paths.slice(0, SvnConflictWords.listedPathsConst)
    const rest = paths.length - shown.length + set.more
    if (shown.length === 0 && rest === 0) return `${SvnConflictWords.summaryOf(set)}; ${again}`
    return `${SvnConflictWords.summaryOf(set)}: ${shown.join(', ')}${rest > 0 ? ` and ${rest} more` : ''}; settle them, then ${again}`
  }

  /** The wait of an UPDATE whose rules left conflicts an agent may settle: one press, the agent's. */
  static agentReasonOf(set: SvnActionConflictSet): string {
    const paths = set.entries.filter((entry) => entry.state !== 'settled').map((entry) => entry.path)
    const shown = paths.slice(0, SvnConflictWords.listedPathsConst)
    const rest = paths.length - shown.length + set.more
    return `${SvnConflictWords.summaryOf(set)}: ${shown.join(', ')}${rest > 0 ? ` and ${rest} more` : ''}; Resolve with agent merges them and checks them again`
  }

  /** The conflicts a main copy held before its UPDATE, named apart from the UPDATE's own, at most 20. */
  static olderOf(paths: readonly string[]): string {
    const shown = paths.slice(0, SvnConflictWords.listedPathsConst)
    const rest = paths.length - shown.length
    return `conflicts from before this UPDATE are not part of it and stay yours as svn left them: ${shown.join(', ')}${rest > 0 ? ` and ${rest} more` : ''}`
  }

  /** The reason of a wait whose conflicts are all settled, naming the label of the press that goes on. */
  static settledOf(set: SvnActionConflictSet, press: string): string {
    return `${SvnConflictWords.summaryOf(set)}; all are settled, press ${press} to go on`
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
        case 'leftovers': {
          const shown = finding.paths.slice(0, SvnConflictWords.listedPathsConst)
          const rest = finding.paths.length - shown.length
          const one = finding.paths.length === 1
          return `${shown.join(', ')}${rest > 0 ? ` and ${rest} more` : ''} ${one ? 'is a leftover svn conflict file' : 'are leftover svn conflict files'}, delete ${one ? 'it' : 'them'}`
        }
        default: throw new Error(`Unknown guard finding: ${JSON.stringify(kind satisfies never)}`)
      }
    }).join('; ')
  }

  /**
   * The entries in the wire's words: every open one first, so no path that needs a choice hides behind
   * settled ones (the record bounds them), then the settled ones up to `max` entries in all, and how
   * many more the set holds.
   */
  static listOf(set: SvnActionConflictSet, max: number, side: SvnConflictSide = 'worktree'): { entries: SessionSvnConflictInfo[]; more: number } {
    const open = set.entries.filter((entry) => entry.state !== 'settled')
    const settled = set.entries.filter((entry) => entry.state === 'settled').slice(0, Math.max(0, max - open.length))
    const shown = [...open, ...settled]
    return { entries: shown.map((entry) => SvnConflictWords.infoOf(entry, side)), more: set.entries.length - shown.length + set.more }
  }

  static infoOf(entry: SvnActionConflictEntry, side: SvnConflictSide = 'worktree'): SessionSvnConflictInfo {
    return {
      path: entry.path,
      kind: entry.kind,
      state: entry.state,
      description: SvnConflictWords.descriptionOf(entry, side),
      by: entry.by === 'merger' ? 'agent' : entry.by ?? null,
      ...SvnConflictWords.settledWordOf(entry),
      saved: entry.saved ?? null,
      options: entry.options.map((option) => SvnConflictWords.optionOf(entry, option, side)),
    }
  }

  /** The local side in words: "Your session" and "the session's", or "Your main copy" and "your". */
  private static sideOf(side: SvnConflictSide): { who: string; whose: string; doer: string } {
    switch (side) {
      case 'worktree': return { who: 'Your session', whose: "the session's", doer: 'the session' }
      case 'main-copy': return { who: 'Your main copy', whose: 'your', doer: 'you' }
      default: throw new Error(`Unknown conflict side: ${JSON.stringify(side satisfies never)}`)
    }
  }

  /** Who settles or settled a path: "Jamat's rule", "the worker", "the merger", and the person as `person` names them. */
  static actorOf(by: SvnConflictActor, person: string): string {
    switch (by) {
      case 'jamat': return "Jamat's rule"
      case 'agent': return 'the worker'
      case 'merger': return 'the merger'
      case 'person': return person
      default: throw new Error(`Unknown conflict actor: ${JSON.stringify(by satisfies never)}`)
    }
  }

  /**
   * The durable result's line per settled path: Jamat's rules keep their FIXED line, every other
   * settlement names its option and who chose it, each followed by where its saved copy is.
   */
  /** Each unpublished path still in conflict once, with a note: svn's conflict files beside it are left out of the list. */
  static remainingOf(paths: readonly string[], entries: readonly SvnActionConflictEntry[]): string[] {
    const open = new Set(entries.filter((entry) => entry.state !== 'settled').map((entry) => entry.path))
    return paths.map((path) => open.has(path) ? `${path} (in conflict, with its svn conflict files)` : path)
  }

  static resultLinesOf(entries: readonly SvnActionConflictEntry[]): string[] {
    return entries.flatMap((entry) => {
      if (entry.state !== 'settled') return []
      // A file with a text and a property conflict settles each with its own option.
      const kind = entries.some((other) => other !== entry && other.path === entry.path) ? `${entry.kind}: ` : ''
      const option = entry.settledWith === undefined ? '' : ` (${kind}${SvnConflictWords.optionWordOf(entry.settledWith)})`
      const line = entry.by === 'jamat' ? `FIXED: ${entry.path}${option}`
        : `SETTLED: ${entry.path}${option} by ${entry.by === undefined ? 'svn' : SvnConflictWords.actorOf(entry.by, 'the person')}${entry.settledWith === undefined ? ' outside Jamat' : ''}`
      return [line, ...entry.saved === undefined ? [] : [`   saved copies: ${entry.saved}`]]
    })
  }

  /** "fixed by the worker: Keep mine" for a settled path, "Jamat's rule applies Keep both" for one a rule takes; nothing while nobody chose. */
  private static settledWordOf(entry: SvnActionConflictEntry): { settled?: string } {
    const state = entry.state
    switch (state) {
      case 'rule': return entry.rule === undefined ? {} : { settled: `Jamat's rule applies ${SvnConflictWords.optionOf(entry, entry.rule).label}` }
      case 'settled': {
        if (entry.by === undefined) return {}
        const actor = SvnConflictWords.actorOf(entry.by, 'you')
        return { settled: entry.settledWith === undefined ? `fixed by ${actor} outside Jamat; svn no longer marks it`
          : `fixed by ${actor}: ${SvnConflictWords.optionOf(entry, entry.settledWith).label}` }
      }
      case 'agent': case 'person': return {}
      default: throw new Error(`Unknown conflict state: ${JSON.stringify(state satisfies never)}`)
    }
  }

  /** The conflict a refusal names: "text conflict", "binary file conflict", "property conflict". */
  static conflictWordOf(entry: Pick<SvnActionConflictEntry, 'kind' | 'shape'>): string {
    if (entry.shape === 'binary') return 'binary file conflict'
    if (entry.shape === 'text-unreadable') return 'conflict on a file that is not UTF-8 text'
    return `${entry.kind} conflict`
  }

  /** One sentence from the facts: what the session (or the main copy) did, what the other commit did. */
  static descriptionOf(entry: SvnActionConflictEntry, side: SvnConflictSide = 'worktree'): string {
    const who = SvnConflictWords.sideOf(side).who
    const facts = entry.facts
    const revision = SvnConflictWords.revisionOf(entry)
    const node = SvnConflictWords.nodeOf(facts.localKind ?? facts.incomingKind)
    const properties = (facts.properties ?? []).join(', ')
    const shape: SvnConflictShape = entry.shape
    switch (shape) {
      case 'text-overlap': return `${who} and ${revision} changed the same lines of this file.`
      case 'text-same': return `${who} and ${revision} wrote the same text; only the line ends differ.`
      case 'binary': return `${who} and ${revision} both changed this binary file.`
      case 'text-unreadable': return `${who} and ${revision} both changed this file, which is not UTF-8 text.`
      case 'name-unsafe': return 'svn cannot take this name as an argument, so Jamat writes nothing for it; resolve it in an SVN client such as TortoiseSVN, then check again.'
      case 'mergeinfo': return `${who} and ${revision} both changed svn:mergeinfo.`
      case 'property-unknown': return 'SVN reports a property conflict whose values could not be compared. Inspect the properties before choosing a resolution.'
      case 'line-list-property': case 'property-value':
        return properties === '' ? `${who} and ${revision} set the same property values.` : `${who} and ${revision} both changed ${properties}.`
      case 'externals': return `${who} and ${revision} both changed svn:externals${properties.includes(',') ? ` (with ${properties})` : ''}.`
      case 'obstructed-dir': {
        const files = facts.files
        if (files === undefined) return `${who} added this folder; ${revision} added it too.`
        const differing = files.differing === 0 ? '' : ` ${SvnConflictWords.files(files.differing)} with the same name ${files.differing === 1 ? 'differs' : 'differ'}.`
        return `${who} added this folder with ${SvnConflictWords.files(files.local)}; ${revision} added it with ${SvnConflictWords.files(files.incoming)}.${differing}`
      }
      case 'obstructed-file': return `${who} added this file; ${revision} added it too.`
      case 'added-both': return `${who} and ${revision} both added this ${node}.`
      case 'kind-mismatch':
        return `${who} has a ${SvnConflictWords.nodeOf(facts.localKind)} here; ${revision} added a ${SvnConflictWords.nodeOf(facts.incomingKind)}.`
      case 'edit-vs-delete': {
        const movedTo = facts.movedTo
        if (movedTo === undefined) return `${who} changed this ${node}; ${revision} deleted it.`
        return facts.localKind === 'dir'
          ? `${who} changed this folder; ${revision} moved it to ${movedTo}. Jamat cannot carry folder changes there: copy them into ${movedTo} by hand, then take incoming.`
          : `${who} changed this ${node}; ${revision} moved it to ${movedTo}.`
      }
      case 'edit-vs-replace': return `${who} changed this ${node}; ${revision} replaced it.`
      case 'delete-vs-edit':
        return facts.reason === 'moved-away' && facts.movedTo !== undefined
          ? `${who} moved this ${node} to ${facts.movedTo}; ${revision} changed it.`
          : `${who} ${SvnConflictWords.removedOf(entry)} this ${node}; ${revision} changed it.`
      case 'delete-vs-delete': return `${who} and ${revision} both deleted this ${node}.`
      case 'replace-or-case': return `${who} replaced this ${node}; ${revision} changed it.`
      case 'diverged': return `A file of the same name differs between ${who.toLowerCase()} and ${revision}.`
      case 'drops-incoming':
        return facts.dropped === undefined || facts.dropped === 0
          ? `The commit would drop what ${revision} brought in.`
          : `The commit would delete ${SvnConflictWords.files(facts.dropped)} ${revision} ${SvnConflictWords.broughtOf(entry)}.`
      case 'unrecognized': return 'svn reports a conflict Jamat does not know; resolve it in an SVN client, then check again.'
      default: throw new Error(`Unknown conflict shape: ${JSON.stringify(shape satisfies never)}`)
    }
  }

  private static optionOf(entry: SvnActionConflictEntry, id: SvnConflictOption, side: SvnConflictSide = 'worktree'): SessionSvnConflictOptionInfo {
    const revision = SvnConflictWords.revisionOf(entry)
    const { whose, doer } = SvnConflictWords.sideOf(side)
    const folder = entry.facts.incomingKind === 'dir' && entry.kind === 'tree'
    const properties = (entry.facts.properties ?? []).join(', ')
    let label: string
    let note: string
    switch (id) {
      case 'merged':
        label = 'Merge'
        note = entry.kind === 'property' ? 'keeps the working-copy property value and marks it resolved; confirm that you incorporated the incoming changes'
          : entry.kind === 'tree' ? 'keeps the working-copy tree and marks it resolved; confirm that you incorporated the incoming changes'
          : 'edit the file to the merged text; then it is marked resolved'
        break
      case 'take-incoming':
        label = 'Take incoming'
        if (folder) note = `restores what ${revision} added; ${whose} files are saved first, then removed`
        else if (entry.shape === 'text-same') note = `takes the version of ${revision}, which keeps its svn:eol-style; ${whose} version differed only in line ends`
        else if (entry.kind === 'property')
          note = `takes the value of ${revision} and drops ${whose} own value${properties === '' ? '' : ` of ${properties}`}; a copy is saved first`
        else note = `takes the version of ${revision} and drops ${whose} own changes to this ${entry.kind === 'tree' ? SvnConflictWords.nodeOf(entry.facts.localKind ?? entry.facts.incomingKind) : 'file'}; a copy is saved first`
        break
      case 'keep-mine':
        label = 'Keep mine'
        note = entry.kind === 'tree' && entry.facts.action === 'added'
          ? `keeps ${whose} version; the commit would delete ${SvnConflictWords.addedOf(entry, folder)} ${revision} added`
          : `keeps ${whose} version; what ${revision} brought is dropped`
        break
      case 'keep-both': {
        const { reason, movedTo } = entry.facts
        const node = SvnConflictWords.nodeOf(entry.facts.localKind)
        const conflict = 'lines both sides changed become a text conflict there'
        if (reason === 'moved-away') {
          const place = movedTo ?? `the place ${doer} moved this ${node} to`
          label = movedTo === undefined ? `Apply to moved ${node}` : `Apply to ${movedTo}`
          note = `applies the change of ${revision} to ${place}${movedTo === undefined ? '' : `, where ${doer} moved this ${node}`}; ${conflict}`
        }
        else if (movedTo !== undefined) {
          label = `Move my changes to ${movedTo}`
          note = `applies ${whose} changes to ${movedTo}, where ${revision} moved this ${node}, and drops the old place; ${conflict}; a copy is saved first`
        }
        else {
          label = 'Keep both'
          note = folder ? `restores the files ${revision} added and keeps ${whose} files beside them`
            : `keeps ${whose} ${node} beside the one ${revision} added`
        }
        break
      }
      case 'union':
        label = 'Union'
        note = entry.shape === 'mergeinfo' ? 'keeps the merged revision ranges of both sides'
          : `keeps the lines of ${revision}, adds the lines ${doer} added and leaves out the ones it removed`
        break
      default: throw new Error(`Unknown conflict option: ${JSON.stringify(id satisfies never)}`)
    }
    return { id, label, note, loses: id === 'merged' && (entry.kind === 'property' || entry.kind === 'tree') ? 'incoming' : SvnConflictShapes.lossOf(id) }
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
