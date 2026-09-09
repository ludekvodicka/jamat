import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  DeletePreview,
  VirtualFolderDef,
} from '../../../../../lib-orchestrator/projectManager/projectManagerApi.types'
import { ManageStrip, ManageText } from './manageStrip'
import { type ManageInput, ManageModel, type ManageState } from './manageModel'

describe('app-client-ui/renderer/overlays/launcher/manageStrip', () => {
  const nowConst = Date.UTC(2026, 7, 5, 12, 0)
  /** Every answer names the project it ran on, and here that is always the row the panel sits under. */
  const projectConst = { categoryId: 'nodejs', name: 'AppJamatV2' }

  afterEach(cleanup)

  function preview(): DeletePreview {
    return {
      token: 't-1',
      expiresAt: nowConst + 4 * 60_000,
      projectPath: 'C:/Projects/NodeJs/AppJamatV2',
      projectFileCount: 1284,
      claude: { encodedDirectory: 'Q--AppJamatV2', transcriptFiles: ['a', 'b'] },
      codex: { rolloutFiles: ['c'] },
    }
  }

  function on(...inputs: readonly ManageInput[]): ManageState {
    let state = ManageModel.initial()
    const all: readonly ManageInput[] = [
      { input: 'aim', target: { categoryId: 'nodejs', projectName: 'AppJamatV2' } },
      ...inputs,
    ]
    for (const input of all)
      state = ManageModel.transition(state, input).state
    return state
  }

  const foldersConst: readonly VirtualFolderDef[] = [{ prefix: 'archive/', title: 'archive' }]

  function draw(manage: ManageState, folders: readonly VirtualFolderDef[] = foldersConst) {
    const dispatch = vi.fn<(input: ManageInput) => void>()
    const view = render(
      <ManageStrip manage={manage} folders={folders} now={nowConst} dispatch={dispatch} />,
    )
    return { view, dispatch }
  }

  function buttons(container: HTMLElement): string[] {
    return [...container.querySelectorAll('button')].map((node) => node.textContent ?? '')
  }

  function click(container: HTMLElement, label: string): void {
    const button = [...container.querySelectorAll('button')]
      .find((node) => node.textContent === label)
    if (!button)
      throw new Error(`No button reads ${JSON.stringify(label)}: ${buttons(container).join(', ')}`)
    fireEvent.click(button)
  }

  /**
   * The four things that can be done are keys named on the card's line, not buttons here: this strip
   * is what an operation ASKS. With nothing asked and nothing to report it says nothing at all, which
   * is what `ManageModel.hasStrip` decides before the card draws it.
   */
  it('says nothing while nothing is being asked', () => {
    const { view } = draw(on())

    expect(buttons(view.container)).toEqual([])
    expect(view.container.textContent).toBe('')
  })

  /**
   * Every prompt names its project. Drawn under the row it acted on, the panel's POSITION said which
   * one; from the card's edge nothing else does, and the cursor is at the other end of the card.
   */
  it('names the project in every question it asks', () => {
    const rename = draw(on({ input: 'renameStart' }))
    expect(rename.view.container.textContent).toContain('Rename AppJamatV2 to')
    cleanup()

    const move = draw(on({ input: 'movePrefixStart' }))
    expect(move.view.container.textContent).toContain('Move AppJamatV2 to')
    cleanup()

    const archive = draw(on({ input: 'archiveStart' }))
    expect(archive.view.container.textContent).toContain('Archive AppJamatV2?')
    cleanup()

    // Off the operation's own name rather than the target's: a delete outlives the cursor.
    const deleting = draw(on({ input: 'deleteStart' }))
    expect(deleting.view.container.textContent).toContain('deleting AppJamatV2 would take')
  })

  it('sends the edit through as the model input, not as a name of its own', () => {
    const { view, dispatch } = draw(on({ input: 'renameStart' }))
    const edit = view.container.querySelector('.jamat-launcher-manage__edit')
    if (!(edit instanceof HTMLInputElement))
      throw new Error('The rename drew no edit')

    expect(edit.value).toBe('AppJamatV2')
    fireEvent.change(edit, { target: { value: 'AppJamatV3' } })

    expect(dispatch).toHaveBeenCalledWith({ input: 'renameChanged', name: 'AppJamatV3' })
  })

  it('names the folders by their title and offers leaving them', () => {
    const { view, dispatch } = draw(on({ input: 'movePrefixStart' }))

    expect(buttons(view.container)).toEqual(['archive', 'Root (no folder)'])
    click(view.container, 'Root (no folder)')

    expect(dispatch).toHaveBeenCalledWith({ input: 'movePrefixChosen', targetPrefix: null })
  })

  /**
   * The case the old target list could not reach: a folder holds nothing until the first project is
   * moved into it, so a list read off the drawn entries offered every folder except the new one.
   */
  it('offers a folder that is still empty', () => {
    const { view, dispatch } = draw(on({ input: 'movePrefixStart' }), [
      { prefix: 'archive/', title: 'archive' },
      { prefix: 'temporary', title: 'Temporary projects' },
    ])

    expect(buttons(view.container)).toEqual(['archive', 'Temporary projects', 'Root (no folder)'])
    click(view.container, 'Temporary projects')

    expect(dispatch).toHaveBeenCalledWith({ input: 'movePrefixChosen', targetPrefix: 'temporary' })
  })

  it('offers only leaving when the root defines no folder at all', () => {
    const { view } = draw(on({ input: 'movePrefixStart' }), [])

    expect(buttons(view.container)).toEqual(['Root (no folder)'])
  })

  it('asks before archiving and names what it would archive', () => {
    const { view, dispatch } = draw(on({ input: 'archiveStart' }))

    expect(view.container.textContent).toContain('Archive AppJamatV2?')
    click(view.container, 'Archive')

    expect(dispatch).toHaveBeenCalledWith({ input: 'archiveStart' })
  })

  // The whole point of the two calls: what the token binds to is on screen before the button is.
  it('shows the enumeration and puts its count on the button', () => {
    const { view, dispatch } = draw(on(
      { input: 'deleteStart' },
      { input: 'previewReady', ...projectConst, preview: preview() },
    ))

    expect(view.container.textContent).toContain('C:/Projects/NodeJs/AppJamatV2')
    expect(view.container.textContent).toContain('1284 project files')
    expect(view.container.textContent).toContain('2 Claude transcripts')
    expect(view.container.textContent).toContain('1 Codex rollouts')
    expect(view.container.textContent).toContain('expires in 4 min')

    click(view.container, 'Delete 1287 files')
    expect(dispatch).toHaveBeenCalledWith({ input: 'deleteConfirm' })
  })

  it('answers a refused delete with a new preview and never with a retry', () => {
    const { view, dispatch } = draw(on(
      { input: 'deleteStart' },
      { input: 'previewReady', ...projectConst, preview: preview() },
      { input: 'deleteConfirm' },
      { input: 'operationFailed', ...projectConst, code: 'stale-preview', detail: 'The file set changed' },
    ))

    expect(view.container.textContent).toContain('The file set changed')
    expect(view.container.textContent).toContain('stale-preview')

    click(view.container, 'Preview again')
    expect(dispatch).toHaveBeenCalledWith({ input: 'deleteStart' })
  })

  it('shows a typed refusal word for word', () => {
    const { view } = draw(on(
      { input: 'renameStart' },
      { input: 'operationFailed', ...projectConst, code: 'target-exists', detail: 'AppJamat already exists' },
    ))

    expect(view.container.querySelector('.jamat-launcher-manage__error')?.textContent)
      .toBe('target-exists · AppJamat already exists')
  })

  it('reports what the relocation did, leftovers included', () => {
    const { view } = draw(on({
      input: 'relocated',
      categoryId: 'nodejs',
      name: 'AppJamatV2',
      report: {
        operationId: 'op-1',
        directoryRenamed: true,
        providers: { claude: 'done', codex: 'done-with-leftovers' },
        leftoverCount: 3,
      },
    }))

    expect(view.container.querySelector('.jamat-launcher-manage__report')?.textContent)
      .toBe('Directory renamed · Claude done · Codex done-with-leftovers')
    expect(view.container.querySelector('.jamat-launcher-manage__warn')?.textContent)
      .toBe('3 files left behind; the startup sweep retries them')
  })

  it('reads an expiry as time left, and a passed one as passed', () => {
    expect(ManageText.expiryOf(nowConst + 90_000, nowConst)).toBe('expires in 2 min')
    expect(ManageText.expiryOf(nowConst, nowConst)).toBe('has expired')
  })

  it('throws on a delete phase it does not know', () => {
    const broken = {
      ...on({ input: 'deleteStart' }),
      operation: { op: 'delete' as const, phase: { phase: 'teleporting' } },
    } as unknown as ManageState

    expect(() => draw(broken)).toThrow(/Unknown delete phase/)
  })
})
