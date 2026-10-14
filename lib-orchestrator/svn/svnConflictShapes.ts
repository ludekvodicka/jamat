import type { SvnConflictFact, SvnConflictLoss, SvnConflictOption, SvnConflictPlan, SvnConflictShape } from './svn.types'

/**
 * The classifier: one conflicted path's svn facts and content to its shape, the options the shape
 * admits, the rule where the facts prove an option lossless, and whether an agent may settle it.
 * It decides by facts only, never by a path name (`docs/architecture/svn-conflict-resolution.md`).
 */
export class SvnConflictShapes {
  /** A new shape does not compile until it has a row. */
  private static readonly plansConst = {
    'text-overlap': { options: ['merged', 'take-incoming', 'keep-mine'], agent: true },
    'text-same': { options: ['merged', 'take-incoming', 'keep-mine'], agent: true },
    'binary': { options: ['take-incoming', 'keep-mine'], agent: false },
    'text-unreadable': { options: ['take-incoming', 'keep-mine'], agent: false },
    'name-unsafe': { options: [], agent: false },
    'mergeinfo': { options: ['union', 'take-incoming', 'keep-mine'], agent: true },
    'line-list-property': { options: ['union', 'merged', 'take-incoming', 'keep-mine'], agent: true },
    'property-value': { options: ['merged', 'take-incoming', 'keep-mine'], agent: true },
    'externals': { options: ['merged', 'take-incoming', 'keep-mine'], agent: false },
    'obstructed-file': { options: ['merged', 'take-incoming', 'keep-mine'], agent: true },
    'obstructed-dir': { options: ['keep-both', 'take-incoming', 'keep-mine'], agent: true },
    'added-both': { options: ['keep-both', 'merged', 'take-incoming', 'keep-mine'], agent: true },
    'kind-mismatch': { options: ['take-incoming', 'keep-mine'], agent: false },
    'edit-vs-delete': { options: ['merged', 'take-incoming', 'keep-mine'], agent: true },
    'edit-vs-replace': { options: ['merged', 'take-incoming', 'keep-mine'], agent: true },
    'delete-vs-edit': { options: ['take-incoming', 'keep-mine'], agent: false },
    'delete-vs-delete': { options: ['merged'], agent: true },
    'replace-or-case': { options: ['take-incoming', 'keep-mine'], agent: false },
    'diverged': { options: ['merged', 'take-incoming', 'keep-mine'], agent: true },
    'drops-incoming': { options: ['keep-both', 'keep-mine'], agent: false },
    'unrecognized': { options: ['take-incoming', 'keep-mine'], agent: false },
  } as const satisfies Record<SvnConflictShape, { options: readonly SvnConflictOption[]; agent: boolean }>

  /** Properties whose value is a list of lines, one entry each. */
  private static readonly lineListPropertiesConst: readonly string[] = ['svn:ignore', 'svn:global-ignores']

  static planOf(fact: SvnConflictFact): SvnConflictPlan {
    if (!fact.takesArgument) return SvnConflictShapes.of('name-unsafe', null)
    const kind = fact.kind
    switch (kind) {
      case 'text': return SvnConflictShapes.textOf(fact)
      case 'property': return SvnConflictShapes.propertyOf(fact)
      case 'tree': return SvnConflictShapes.treeOf(fact)
      default: throw new Error(`Unknown conflict kind: ${JSON.stringify(kind satisfies never)}`)
    }
  }

  /** The options a shape admits, in drawing order. */
  static optionsOf(shape: SvnConflictShape): readonly SvnConflictOption[] {
    return SvnConflictShapes.plansConst[shape].options
  }

  /** Whether an agent (the merger) may settle a path of this shape. */
  static agentOf(shape: SvnConflictShape): boolean {
    return SvnConflictShapes.plansConst[shape].agent
  }

  /** Whether a value read from disk names a shape of this build. */
  static isShape(value: unknown): value is SvnConflictShape {
    return typeof value === 'string' && Object.hasOwn(SvnConflictShapes.plansConst, value)
  }

  static isOption(value: unknown): value is SvnConflictOption {
    return value === 'merged' || value === 'take-incoming' || value === 'keep-mine' || value === 'keep-both' || value === 'union'
  }

  static lossOf(option: SvnConflictOption): SvnConflictLoss {
    switch (option) {
      case 'merged': case 'keep-both': case 'union': return 'nothing'
      case 'take-incoming': return 'mine'
      case 'keep-mine': return 'incoming'
      default: throw new Error(`Unknown conflict option: ${JSON.stringify(option satisfies never)}`)
    }
  }

  /**
   * A text conflict that also has a property conflict gets no rule: no single proof covers both. Equal
   * bytes, or text that differs only in line ends, take the incoming file, which keeps its
   * `svn:eol-style`; the working file holds svn's markers, so `merged` could not settle it.
   */
  private static textOf(fact: SvnConflictFact): SvnConflictPlan {
    const content = fact.content
    if (content === null) return SvnConflictShapes.of('unrecognized', null)
    const proven = fact.properties.length === 0
    if (content.unreadable) return SvnConflictShapes.of('text-unreadable', null)
    if (content.binary) return SvnConflictShapes.of('binary', proven && content.equal === 'bytes' ? 'take-incoming' : null)
    if (content.equal === 'bytes' || content.equal === 'eol') return SvnConflictShapes.of('text-same', proven ? 'take-incoming' : null)
    return SvnConflictShapes.of('text-overlap', null)
  }

  /**
   * svn names no property in a conflict; an empty list means every value agrees on two sides. Line
   * lists merge three ways without a loss. `svn:mergeinfo` gets no rule: svn 1.14 merges its ranges
   * itself on update, so a Finish never meets it (the spike).
   */
  private static propertyOf(fact: SvnConflictFact): SvnConflictPlan {
    const names = fact.properties.map((property) => property.name)
    if (names.length === 0) return SvnConflictShapes.of('property-value', 'merged')
    if (names.includes('svn:externals')) return SvnConflictShapes.of('externals', null)
    if (names.every((name) => name === 'svn:mergeinfo')) return SvnConflictShapes.of('mergeinfo', null)
    if (names.every((name) => SvnConflictShapes.lineListPropertiesConst.includes(name))) return SvnConflictShapes.of('line-list-property', 'union')
    return SvnConflictShapes.of('property-value', null)
  }

  private static treeOf(fact: SvnConflictFact): SvnConflictPlan {
    const tree = fact.tree
    if (tree === null) return SvnConflictShapes.of('unrecognized', null)
    const { reason, action, localKind, incomingKind } = tree
    if (reason === 'unrecognized' || action === 'unrecognized') return SvnConflictShapes.of('unrecognized', null)
    if (localKind !== 'none' && incomingKind !== 'none' && localKind !== incomingKind)
      return SvnConflictShapes.of('kind-mismatch', null)
    if ((reason === 'unversioned' || reason === 'obstructed') && action === 'added')
      return incomingKind === 'dir'
        ? SvnConflictShapes.of('obstructed-dir', fact.content?.files === undefined ? null : 'keep-both')
        : SvnConflictShapes.of('obstructed-file', fact.content?.equal === 'bytes' ? 'take-incoming' : null)
    if ((reason === 'added' || reason === 'moved-here') && action === 'added')
      return SvnConflictShapes.addedBoth(fact)
    if ((reason === 'deleted' || reason === 'missing' || reason === 'moved-away') && action === 'deleted')
      return SvnConflictShapes.of('delete-vs-delete', 'merged')
    if ((reason === 'deleted' || reason === 'missing' || reason === 'moved-away') && (action === 'edited' || action === 'replaced'))
      return SvnConflictShapes.of('delete-vs-edit', null)
    if (reason === 'edited' && action === 'deleted') return SvnConflictShapes.of('edit-vs-delete', null)
    if (reason === 'edited' && action === 'replaced') return SvnConflictShapes.of('edit-vs-replace', null)
    if (reason === 'replaced') return SvnConflictShapes.of('replace-or-case', null)
    return SvnConflictShapes.of('unrecognized', null)
  }

  /** Both sides added: keep-both for a directory, merged for a file; a local add with history is never reverted by a rule. */
  private static addedBoth(fact: SvnConflictFact): SvnConflictPlan {
    const tree = fact.tree
    if (tree === null) throw new Error('An add on both sides has tree facts')
    const dir = tree.incomingKind === 'dir'
    const rule = tree.localHistory ? null
      : dir ? fact.content?.files === undefined ? null : 'keep-both'
      : fact.content?.equal === 'bytes' ? 'take-incoming'
      : null
    const plan = SvnConflictShapes.of('added-both', rule)
    return { ...plan, options: plan.options.filter((option) => option !== (dir ? 'merged' : 'keep-both')) }
  }

  private static of(shape: SvnConflictShape, rule: SvnConflictOption | null): SvnConflictPlan {
    const row = SvnConflictShapes.plansConst[shape]
    return { shape, options: row.options, rule, agent: row.agent }
  }
}
