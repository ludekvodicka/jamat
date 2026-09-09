import { describe, expect, it } from 'vitest'

import type {
  DeletePreview,
  RelocationReport,
} from '../../../../../lib-orchestrator/projectManager/projectManagerApi.types'
import {
  type ManageEffect,
  type ManageInput,
  ManageModel,
  type ManageState,
} from './manageModel'

describe('app-client-ui/renderer/overlays/launcher/manageModel', () => {
  class Run {
    private constructor(
      readonly state: ManageState,
      readonly effects: readonly ManageEffect[],
    ) {}

    static onProject(): Run {
      return new Run(ManageModel.initial(), []).then({
        input: 'aim',
        target: { categoryId: 'nodejs', projectName: 'AppJamatV2' },
      })
    }

    then(...inputs: readonly ManageInput[]): Run {
      let state = this.state
      let effects: readonly ManageEffect[] = []
      for (const input of inputs) {
        const step = ManageModel.transition(state, input)
        state = step.state
        effects = step.effects
      }
      return new Run(state, effects)
    }
  }

  function preview(token: string): DeletePreview {
    return {
      token,
      expiresAt: Date.UTC(2026, 7, 5, 12, 5),
      projectPath: 'C:/Projects/NodeJs/AppJamatV2',
      projectFileCount: 1284,
      claude: { encodedDirectory: 'C--Projects-NodeJs-AppJamatV2', transcriptFiles: ['a', 'b'] },
      codex: { rolloutFiles: ['c'] },
    }
  }

  /** A preview names the project it walked, so a test can land one on a delete that is not its own. */
  function landed(name: string, token: string): ManageInput {
    return { input: 'previewReady', categoryId: 'nodejs', name, preview: preview(token) }
  }

  function report(leftoverCount: number): RelocationReport {
    return {
      operationId: 'op-1',
      directoryRenamed: true,
      providers: { claude: 'done', codex: 'done-with-leftovers' },
      leftoverCount,
    }
  }

  it('starts with nothing under it', () => {
    expect(ManageModel.initial()).toEqual({
      target: null,
      operation: null,
      lastReport: null,
      lastDelete: null,
      error: null,
    })
  })

  /** The cursor is what aims this, and moving it onto another project abandons what was half-started. */
  it('follows the cursor onto another project and drops the operation it left', () => {
    const run = Run.onProject()
      .then({ input: 'renameStart' })
      .then({ input: 'aim', target: { categoryId: 'nodejs', projectName: 'AppOther' } })

    expect(run.state.target).toEqual({ categoryId: 'nodejs', projectName: 'AppOther' })
    expect(run.state.operation).toBeNull()
  })

  it('seeds the rename edit with the name it is renaming', () => {
    const run = Run.onProject().then({ input: 'renameStart' })

    expect(run.state.operation).toEqual({ op: 'rename', name: 'AppJamatV2' })
  })

  it('renames through the library and never through a name it made up', () => {
    const run = Run.onProject()
      .then({ input: 'renameStart' }, { input: 'renameChanged', name: 'AppJamatV3' }, { input: 'renameConfirm' })

    expect(run.effects).toEqual([{
      effect: 'rename',
      categoryId: 'nodejs',
      oldName: 'AppJamatV2',
      newName: 'AppJamatV3',
    }])
  })

  it('does nothing for a rename to the same name or to nothing', () => {
    const unchanged = Run.onProject().then({ input: 'renameStart' }, { input: 'renameConfirm' })
    expect(unchanged.effects).toEqual([])

    const empty = Run.onProject()
      .then({ input: 'renameStart' }, { input: 'renameChanged', name: '  ' }, { input: 'renameConfirm' })
    expect(empty.effects).toEqual([])
  })

  // The typed error belongs at the row, and the edit that caused it has to survive being told so.
  it('keeps the edit standing when the library refuses the name', () => {
    const run = Run.onProject()
      .then({ input: 'renameStart' }, { input: 'renameChanged', name: 'AppJamat' }, { input: 'renameConfirm' })
      .then({
        input: 'operationFailed',
        categoryId: 'nodejs',
        name: 'AppJamatV2',
        code: 'target-exists',
        detail: 'AppJamat already exists',
      })

    expect(run.state.operation).toEqual({ op: 'rename', name: 'AppJamat' })
    expect(run.state.error).toEqual({ code: 'target-exists', detail: 'AppJamat already exists' })
  })

  it('moves into a folder and out of it by the same input', () => {
    const into = Run.onProject()
      .then({ input: 'movePrefixStart' }, { input: 'movePrefixChosen', targetPrefix: 'archive/' })
    expect(into.effects).toEqual([{
      effect: 'movePrefix', categoryId: 'nodejs', name: 'AppJamatV2', targetPrefix: 'archive/',
    }])

    const out = Run.onProject()
      .then({ input: 'movePrefixStart' }, { input: 'movePrefixChosen', targetPrefix: null })
    expect(out.effects).toEqual([{
      effect: 'movePrefix', categoryId: 'nodejs', name: 'AppJamatV2', targetPrefix: null,
    }])
  })

  it('archives on the second ask and not on the first', () => {
    const asked = Run.onProject().then({ input: 'archiveStart' })
    expect(asked.effects).toEqual([])
    expect(asked.state.operation).toEqual({ op: 'archive', confirming: true })

    const done = asked.then({ input: 'archiveStart' })
    expect(done.effects).toEqual([{ effect: 'archive', categoryId: 'nodejs', name: 'AppJamatV2' }])
  })

  it('drops a pending archive confirmation the moment anything else starts', () => {
    const run = Run.onProject().then({ input: 'archiveStart' }, { input: 'renameStart' })

    expect(run.state.operation).toEqual({ op: 'rename', name: 'AppJamatV2' })
  })

  it('walks the delete from preview to execute and refetches after it', () => {
    const previewing = Run.onProject().then({ input: 'deleteStart' })
    expect(previewing.state.operation).toEqual({
      op: 'delete',
      categoryId: 'nodejs',
      name: 'AppJamatV2',
      phase: { phase: 'previewing' },
    })
    expect(previewing.effects)
      .toEqual([{ effect: 'deletePreview', categoryId: 'nodejs', name: 'AppJamatV2' }])

    const shown = previewing.then(landed('AppJamatV2', 't-1'))
    expect(shown.state.operation).toEqual({
      op: 'delete',
      categoryId: 'nodejs',
      name: 'AppJamatV2',
      phase: { phase: 'preview', preview: preview('t-1') },
    })

    const executing = shown.then({ input: 'deleteConfirm' })
    expect(executing.effects).toEqual([
      { effect: 'deleteExecute', token: 't-1', categoryId: 'nodejs', name: 'AppJamatV2' },
    ])

    const done = executing.then({
      input: 'deleted',
      categoryId: 'nodejs',
      name: 'AppJamatV2',
      report: { deletedPaths: 1301, leftoverCount: 0 },
    })
    expect(done.state.lastDelete).toEqual({ deletedPaths: 1301, leftoverCount: 0 })
    expect(done.state.target).toBeNull()
    expect(done.effects)
      .toEqual([{ effect: 'refetchProjects', categoryId: 'nodejs', name: 'AppJamatV2' }])
  })

  /**
   * Reading what a delete would take walks a whole project, and Escape during that walk is the
   * ordinary thing to do. The preview then lands with nothing left to tell it to, which is a late
   * answer rather than a fault: it used to throw, and an Escape that ends in an unhandled rejection
   * is an Escape nobody presses twice.
   */
  it('drops a preview that arrives after the delete was cancelled', () => {
    const cancelled = Run.onProject().then({ input: 'deleteStart' }, { input: 'cancel' })

    const late = cancelled.then(landed('AppJamatV2', 't-1'))

    expect(late.state.operation).toBeNull()
    expect(late.effects).toEqual([])
  })

  /**
   * The one that deletes the wrong project if the preview is taken on trust. A walks for seconds, the
   * user gives up on it and starts one on B, and A's answer lands on B's delete: the panel would then
   * draw B while holding A's token, and the confirm would delete A.
   */
  it('drops a preview belonging to a delete the user has already left for another project', () => {
    const onOther = Run.onProject()
      .then({ input: 'deleteStart' }, { input: 'cancel' })
      .then({ input: 'aim', target: { categoryId: 'nodejs', projectName: 'AppJamatV1' } })
      .then({ input: 'deleteStart' })

    const late = onOther.then(landed('AppJamatV2', 't-1'))

    expect(late.state.operation).toEqual({
      op: 'delete',
      categoryId: 'nodejs',
      name: 'AppJamatV1',
      phase: { phase: 'previewing' },
    })
  })

  // A second answer to a walk that was already answered would otherwise put the confirm button back
  // under a delete that is running.
  it('drops a preview that arrives while the delete is executing', () => {
    const executing = Run.onProject()
      .then({ input: 'deleteStart' }, landed('AppJamatV2', 't-1'), { input: 'deleteConfirm' })

    const late = executing.then(landed('AppJamatV2', 't-2'))

    expect(late.state.operation).toEqual({
      op: 'delete',
      categoryId: 'nodejs',
      name: 'AppJamatV2',
      phase: { phase: 'executing', token: 't-1' },
    })
  })

  // The error is drawn at a row, so it belongs to the project it names and to no other.
  it('drops a refusal that names a project other than the one under the cursor', () => {
    const renaming = Run.onProject()
      .then({ input: 'renameStart' }, { input: 'renameChanged', name: 'AppJamat' })

    const late = renaming.then({
      input: 'operationFailed',
      categoryId: 'nodejs',
      name: 'AppJamatV1',
      code: 'target-exists',
      detail: 'AppJamat already exists',
    })

    expect(late.state.error).toBeNull()
    expect(late.state.operation).toEqual({ op: 'rename', name: 'AppJamat' })
  })

  /**
   * A refused delete of a project the user has walked away from used to install an operation nobody
   * could see: without a target the panel draws nothing, while the state still swallowed the next
   * Escape and disabled the key that makes a project.
   */
  it('installs no refusal for a delete that is no longer open', () => {
    const cancelled = Run.onProject()
      .then({ input: 'deleteStart' }, landed('AppJamatV2', 't-1'), { input: 'deleteConfirm' })
      .then({ input: 'cancel' })

    const late = cancelled.then({
      input: 'operationFailed',
      categoryId: 'nodejs',
      name: 'AppJamatV2',
      code: 'stale-preview',
      detail: 'The file set changed',
    })

    expect(late.state.operation).toBeNull()
    expect(late.state.error).toBeNull()
  })

  /**
   * The same race, one step later and with something to say: the operation ran, so its report and
   * the listing it changed are both still wanted. The project rides on the answer, which is why the
   * cursor having moved off that row - the mode stays on, pointed at nothing - costs nothing here.
   */
  it('reports an operation whose row the cursor has already left', () => {
    const moved = Run.onProject()
      .then({ input: 'archiveStart' }, { input: 'archiveStart' }, { input: 'untarget' })

    const done = moved.then({
      input: 'relocated',
      categoryId: 'nodejs',
      name: 'AppJamatV2',
      report: report(0),
    })

    expect(done.state.lastReport).toEqual(report(0))
    expect(done.effects)
      .toEqual([{ effect: 'refetchProjects', categoryId: 'nodejs', name: 'AppJamatV2' }])
  })

  /**
   * The same for the delete, whose window is the longest of the four: the preview walks the project,
   * the execute walks it again, and the cursor may have left that row long before either answered.
   * Both the report and the listing to read again ride on the answer, so the project the delete RAN
   * on is what they name - never wherever the cursor got to by then.
   */
  it('reports a delete whose row the cursor has already left', () => {
    const moved = Run.onProject()
      .then({ input: 'deleteStart' }, landed('AppJamatV2', 't-1'), { input: 'deleteConfirm' })
      .then({ input: 'untarget' })

    const done = moved.then({
      input: 'deleted',
      categoryId: 'nodejs',
      name: 'AppJamatV2',
      report: { deletedPaths: 1301, leftoverCount: 2 },
    })

    expect(done.state.lastDelete).toEqual({ deletedPaths: 1301, leftoverCount: 2 })
    expect(done.effects)
      .toEqual([{ effect: 'refetchProjects', categoryId: 'nodejs', name: 'AppJamatV2' }])
  })

  // The token is the whole protection. There is no path to executing that does not go through the
  // enumeration the user was shown.
  it('refuses to execute a delete outside the preview phase', () => {
    expect(() => Run.onProject().then({ input: 'deleteConfirm' }))
      .toThrow(/outside the preview phase/)
    expect(() => Run.onProject().then({ input: 'deleteStart' }, { input: 'deleteConfirm' }))
      .toThrow(/outside the preview phase/)
  })

  it('turns both delete refusals into a state that offers a new preview', () => {
    const stale = Run.onProject()
      .then({ input: 'deleteStart' }, landed('AppJamatV2', 't-1'))
      .then({ input: 'deleteConfirm' })
      .then({
        input: 'operationFailed',
        categoryId: 'nodejs',
        name: 'AppJamatV2',
        code: 'stale-preview',
        detail: 'The file set changed',
      })
    expect(stale.state.operation).toEqual({
      op: 'delete',
      categoryId: 'nodejs',
      name: 'AppJamatV2',
      phase: { phase: 'refused', code: 'stale-preview', detail: 'The file set changed' },
    })
    expect(stale.state.error).toBeNull()

    const expired = Run.onProject()
      .then({ input: 'deleteStart' }, landed('AppJamatV2', 't-2'))
      .then({ input: 'deleteConfirm' })
      .then({
        input: 'operationFailed',
        categoryId: 'nodejs',
        name: 'AppJamatV2',
        code: 'preview-expired',
        detail: 'The preview expired',
      })
    expect(expired.state.operation).toEqual({
      op: 'delete',
      categoryId: 'nodejs',
      name: 'AppJamatV2',
      phase: { phase: 'refused', code: 'preview-expired', detail: 'The preview expired' },
    })

    // Preview again is the same start, from the refused state.
    expect(expired.then({ input: 'deleteStart' }).effects)
      .toEqual([{ effect: 'deletePreview', categoryId: 'nodejs', name: 'AppJamatV2' }])
  })

  it('keeps the relocation report, leftovers and all, and refetches', () => {
    const run = Run.onProject()
      .then({ input: 'renameStart' }, { input: 'renameChanged', name: 'AppJamatV3' }, { input: 'renameConfirm' })
      .then({ input: 'relocated', categoryId: 'nodejs', name: 'AppJamatV2', report: report(3) })

    expect(run.state.lastReport).toEqual(report(3))
    expect(run.state.operation).toBeNull()
    expect(run.effects).toEqual([{ effect: 'refetchProjects', categoryId: 'nodejs', name: 'AppJamatV2' }])
  })

  /** The cursor moved onto a folder or onto the tail: there is nothing to act on and nothing open. */
  it('drops the operation when the cursor leaves every project', () => {
    const run = Run.onProject().then({ input: 'renameStart' }, { input: 'untarget' })

    expect(run.state.target).toBeNull()
    expect(run.state.operation).toBeNull()
  })

  it('cancels the open operation and keeps the project under it', () => {
    const run = Run.onProject().then({ input: 'deleteStart' }, { input: 'cancel' })

    expect(run.state.operation).toBeNull()
    expect(run.state.target).toEqual({ categoryId: 'nodejs', projectName: 'AppJamatV2' })
  })

  /**
   * What the card asks before it draws the strip. The outcomes outlive their operation on purpose -
   * what a relocation did to each provider, and how many paths a delete took, are the only record of
   * it - so this is not simply `operation !== null`.
   */
  it('has a strip while something is asked and while the last answer still stands', () => {
    expect(ManageModel.hasStrip(ManageModel.initial())).toBe(false)
    expect(ManageModel.hasStrip(Run.onProject().state)).toBe(false)
    expect(ManageModel.hasStrip(Run.onProject().then({ input: 'renameStart' }).state)).toBe(true)

    const reported = Run.onProject()
      .then({ input: 'renameStart' })
      .then({ input: 'relocated', categoryId: 'nodejs', name: 'AppJamatV2', report: report(0) })
    expect(reported.state.operation).toBeNull()
    expect(ManageModel.hasStrip(reported.state)).toBe(true)
  })

  it('refuses to run an operation with no project under it', () => {
    expect(() => ManageModel.transition(ManageModel.initial(), { input: 'renameStart' }))
      .toThrow(/no project under it/)
  })

  it('throws on an input it does not know', () => {
    expect(() => ManageModel.transition(
      ManageModel.initial(),
      { input: 'unarchive' } as unknown as ManageInput,
    )).toThrow(/Unknown manage input/)
  })
})
