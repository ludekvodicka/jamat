import type {
  DeletePreview,
  DeleteReport,
  RelocationReport,
} from '../../../../../lib-orchestrator/projectManager/projectManagerApi.types'

export interface ManageTarget {
  categoryId: string
  projectName: string
}

export type DeletePhase =
  | { phase: 'previewing' }
  /** The enumeration the token is bound to. It is shown; it is not what the delete call carries. */
  | { phase: 'preview'; preview: DeletePreview }
  | { phase: 'executing'; token: string }
  | { phase: 'refused'; code: 'stale-preview' | 'preview-expired'; detail: string }

export type ManageOperation =
  | { op: 'rename'; name: string }
  | { op: 'movePrefix' }
  | { op: 'archive'; confirming: boolean }
  /**
   * The one operation that names its own project. It is the only one whose answers can arrive after
   * it was cancelled and another one started elsewhere, and the only one that ends up carrying a
   * token: the ids that ride beside that token are read from here, never from wherever the cursor
   * has got to by then, so the two can never name different projects.
   */
  | { op: 'delete'; categoryId: string; name: string; phase: DeletePhase }

export interface ManageState {
  /**
   * The project the keys would act on: whatever the cursor stands on, kept in step with it by the
   * card. Null on a folder row and on the two tail rows, where there is nothing to act on.
   *
   * There was a MODE in front of this until 2026-08-11 - `F2`, and the four actions were letters it
   * gated. A mode exists to protect letters; the actions are function keys now, so it had no job left
   * and `R M A D` went back to jumping to a project starting with them.
   */
  target: ManageTarget | null
  operation: ManageOperation | null
  /** The last relocation, shown with its per-provider outcome and its leftover count. */
  lastReport: RelocationReport | null
  lastDelete: DeleteReport | null
  error: { code: string; detail: string } | null
}

export type ManageInput =
  /** The cursor moved onto a project. Moving off an open operation is what cancels it. */
  | { input: 'aim'; target: ManageTarget }
  /** The cursor moved onto something that is not a project, so there is nothing to act on. */
  | { input: 'untarget' }
  | { input: 'renameStart' }
  | { input: 'renameChanged'; name: string }
  | { input: 'renameConfirm' }
  | { input: 'movePrefixStart' }
  | { input: 'movePrefixChosen'; targetPrefix: string | null }
  | { input: 'archiveStart' }
  | { input: 'deleteStart' }
  /**
   * The four answers, and every one of them names the project the call RAN on rather than leaving
   * the model to read the target: an answer can arrive after the cursor has moved off that row, or
   * after the operation it belongs to was cancelled and another one started on another project.
   * What the answer names decides whether it is still wanted - the listing to read again is the one
   * the call changed, and a preview that names something else is not this delete's preview.
   */
  | { input: 'previewReady'; categoryId: string; name: string; preview: DeletePreview }
  | { input: 'deleteConfirm' }
  | { input: 'relocated'; categoryId: string; name: string; report: RelocationReport }
  | { input: 'deleted'; categoryId: string; name: string; report: DeleteReport }
  | { input: 'operationFailed'; categoryId: string; name: string; code: string; detail: string }
  | { input: 'cancel' }

export type ManageEffect =
  | { effect: 'rename'; categoryId: string; oldName: string; newName: string }
  | { effect: 'movePrefix'; categoryId: string; name: string; targetPrefix: string | null }
  | { effect: 'archive'; categoryId: string; name: string }
  | { effect: 'deletePreview'; categoryId: string; name: string }
  /**
   * The token is the whole of what the library is told: it re-enumerates and refuses what moved
   * underneath. The project rides along for this side only, so the answer can name the listing to
   * read again without asking where the cursor has got to by then.
   */
  | { effect: 'deleteExecute'; token: string; categoryId: string; name: string }
  | { effect: 'refetchProjects'; categoryId: string; name: string }

export interface ManageStep {
  state: ManageState
  effects: readonly ManageEffect[]
}

/**
 * What can be done to a project, as a machine of its own.
 *
 * It holds no list and no cursor: the launcher owns those and hands this one a target. Every
 * destructive path here takes two steps, and the delete takes two calls - the preview binds a token
 * to a set of files, and execute carries the token rather than a yes.
 */
export class ManageModel {
  static initial(): ManageState {
    return {
      target: null,
      operation: null,
      lastReport: null,
      lastDelete: null,
      error: null,
    }
  }

  /**
   * Whether the strip has anything to say: an operation being asked, or the outcome of the last one.
   * The outcomes outlive their operation on purpose - what a relocation did to each provider, and how
   * many paths a delete took, are the only record of it - so this is not simply `operation !== null`.
   */
  static hasStrip(state: ManageState): boolean {
    return state.operation !== null
      || state.error !== null
      || state.lastReport !== null
      || state.lastDelete !== null
  }

  static transition(state: ManageState, input: ManageInput): ManageStep {
    if (input.input === 'aim')
      return ManageModel.step(ManageModel.cleared({ ...state, target: input.target }))
    else if (input.input === 'untarget')
      return ManageModel.step(ManageModel.cleared({ ...state, target: null }))
    else if (input.input === 'renameStart') return ManageModel.renameStarted(state)
    else if (input.input === 'renameChanged') return ManageModel.renameChanged(state, input.name)
    else if (input.input === 'renameConfirm') return ManageModel.renameConfirmed(state)
    else if (input.input === 'movePrefixStart')
      return ManageModel.step({ ...ManageModel.cleared(state), operation: { op: 'movePrefix' } })
    else if (input.input === 'movePrefixChosen') return ManageModel.moveChosen(state, input.targetPrefix)
    else if (input.input === 'archiveStart') return ManageModel.archiveStarted(state)
    else if (input.input === 'deleteStart') return ManageModel.deleteStarted(state)
    else if (input.input === 'previewReady') return ManageModel.previewReady(state, input)
    else if (input.input === 'deleteConfirm') return ManageModel.deleteConfirmed(state)
    else if (input.input === 'relocated') return ManageModel.relocated(state, input)
    else if (input.input === 'deleted') return ManageModel.deleted(state, input)
    else if (input.input === 'operationFailed') return ManageModel.failed(state, input)
    else if (input.input === 'cancel') return ManageModel.step(ManageModel.cleared(state))
    else
      throw new Error(`Unknown manage input: ${JSON.stringify(input)}`)
  }

  /** A started operation is the one thing on screen: switching away from it cancels it. */
  private static cleared(state: ManageState): ManageState {
    return { ...state, operation: null, error: null }
  }

  private static target(state: ManageState): ManageTarget {
    if (!state.target)
      throw new Error('A manage operation ran with no project under it')
    return state.target
  }

  private static renameStarted(state: ManageState): ManageStep {
    const target = ManageModel.target(state)
    return ManageModel.step({
      ...ManageModel.cleared(state),
      operation: { op: 'rename', name: target.projectName },
    })
  }

  private static renameChanged(state: ManageState, name: string): ManageStep {
    if (state.operation?.op !== 'rename')
      throw new Error('A rename edit changed with no rename open')
    return ManageModel.step({ ...state, operation: { op: 'rename', name } })
  }

  /** The same name is not a rename, and an empty one is not a name: both leave the edit standing. */
  private static renameConfirmed(state: ManageState): ManageStep {
    if (state.operation?.op !== 'rename')
      throw new Error('A rename was confirmed with no rename open')
    const target = ManageModel.target(state)
    const newName = state.operation.name.trim()
    if (newName.length === 0 || newName === target.projectName)
      return ManageModel.step(state)
    return ManageModel.step(state, {
      effect: 'rename',
      categoryId: target.categoryId,
      oldName: target.projectName,
      newName,
    })
  }

  private static moveChosen(state: ManageState, targetPrefix: string | null): ManageStep {
    if (state.operation?.op !== 'movePrefix')
      throw new Error('A folder was chosen with no move open')
    const target = ManageModel.target(state)
    return ManageModel.step(state, {
      effect: 'movePrefix',
      categoryId: target.categoryId,
      name: target.projectName,
      targetPrefix,
    })
  }

  /** Two steps: the first asks, the second acts. Anything else in between cancels the ask. */
  private static archiveStarted(state: ManageState): ManageStep {
    const target = ManageModel.target(state)
    if (state.operation?.op === 'archive' && state.operation.confirming)
      return ManageModel.step(state, {
        effect: 'archive',
        categoryId: target.categoryId,
        name: target.projectName,
      })
    return ManageModel.step({
      ...ManageModel.cleared(state),
      operation: { op: 'archive', confirming: true },
    })
  }

  private static deleteStarted(state: ManageState): ManageStep {
    const target = ManageModel.target(state)
    return ManageModel.step(
      {
        ...ManageModel.cleared(state),
        operation: {
          op: 'delete',
          categoryId: target.categoryId,
          name: target.projectName,
          phase: { phase: 'previewing' },
        },
      },
      { effect: 'deletePreview', categoryId: target.categoryId, name: target.projectName },
    )
  }

  /**
   * The one answer that can arrive with nothing left to tell: reading what a delete would take walks
   * a whole project, and Escape during that walk is the ordinary thing to do. A late preview is
   * therefore dropped rather than thrown at - unlike every other input here, which comes from a
   * surface that only draws it while the operation is open.
   *
   * Two more things have to hold before it is taken. It has to name THIS delete's project, or A's walk
   * finishing after the user cancelled it and pressed D on B would hand B's panel A's token. And the
   * delete has to still be waiting for it: a preview arriving during an execute would otherwise put
   * the confirm button back under a delete that is already running.
   */
  private static previewReady(
    state: ManageState,
    input: Extract<ManageInput, { input: 'previewReady' }>,
  ): ManageStep {
    const operation = state.operation
    if (operation?.op !== 'delete' || operation.phase.phase !== 'previewing'
      || operation.categoryId !== input.categoryId || operation.name !== input.name)
      return ManageModel.step(state)
    return ManageModel.step({
      ...state,
      operation: { ...operation, phase: { phase: 'preview', preview: input.preview } },
    })
  }

  /**
   * The one door to executing a delete, and it is only open in the preview phase. There is no input
   * that carries a token from anywhere else, so a delete cannot be run without the enumeration the
   * user was shown. The ids come off the operation the preview was accepted into rather than off the
   * target, so the delete that runs and the listing that is read again are the same project.
   */
  private static deleteConfirmed(state: ManageState): ManageStep {
    const operation = state.operation
    if (operation?.op !== 'delete' || operation.phase.phase !== 'preview')
      throw new Error('A delete was confirmed outside the preview phase')
    const token = operation.phase.preview.token
    return ManageModel.step(
      { ...state, operation: { ...operation, phase: { phase: 'executing', token } } },
      {
        effect: 'deleteExecute',
        token,
        categoryId: operation.categoryId,
        name: operation.name,
      },
    )
  }

  private static relocated(
    state: ManageState,
    input: Extract<ManageInput, { input: 'relocated' }>,
  ): ManageStep {
    return ManageModel.step(
      { ...ManageModel.cleared(state), lastReport: input.report },
      { effect: 'refetchProjects', categoryId: input.categoryId, name: input.name },
    )
  }

  private static deleted(
    state: ManageState,
    input: Extract<ManageInput, { input: 'deleted' }>,
  ): ManageStep {
    return ManageModel.step(
      { ...ManageModel.cleared(state), target: null, lastDelete: input.report },
      { effect: 'refetchProjects', categoryId: input.categoryId, name: input.name },
    )
  }

  /**
   * A refused delete keeps its own shape, because the answer to it is a new preview rather than a
   * retry. Every other refusal leaves the operation standing so the edit that caused it survives.
   *
   * A refusal is as late an answer as the report it replaces, so it is dropped the same way. The
   * delete arm needs an execute of THIS project still running, or a refusal of a cancelled delete
   * would install an operation nobody can see - a target-less delete draws nothing, yet still eats
   * the next Escape and disables the key that makes a project. The other arm needs the row the error
   * is drawn at to still be the row it is about.
   */
  private static failed(
    state: ManageState,
    input: Extract<ManageInput, { input: 'operationFailed' }>,
  ): ManageStep {
    const operation = state.operation
    if (input.code === 'stale-preview' || input.code === 'preview-expired') {
      if (operation?.op !== 'delete' || operation.phase.phase !== 'executing'
        || operation.categoryId !== input.categoryId || operation.name !== input.name)
        return ManageModel.step(state)
      return ManageModel.step({
        ...state,
        operation: {
          ...operation,
          phase: { phase: 'refused', code: input.code, detail: input.detail },
        },
        error: null,
      })
    }
    const target = state.target
    if (target === null || target.categoryId !== input.categoryId
      || target.projectName !== input.name)
      return ManageModel.step(state)
    return ManageModel.step({ ...state, error: { code: input.code, detail: input.detail } })
  }

  private static step(state: ManageState, ...effects: readonly ManageEffect[]): ManageStep {
    return { state, effects }
  }
}
