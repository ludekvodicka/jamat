import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { LauncherBinding } from '../launcherBinding'
import { CreateScreenModel, type CreateScreenState } from './createScreenModel'
import { LauncherCreateScreen } from './launcherCreateScreen'

/**
 * The card itself, which the model tests beside this one cannot speak for: what is on screen, and
 * where the caret is. `N` marked the Name row and left the caret where it was, so everything typed
 * after it went to the key handler instead of into the field - `w` toggled the worktree, `n` marked
 * the row again, the rest were dropped - while the footer advertised the key as "Name".
 */
describe('app-client-ui/renderer/overlays/launcher/create/launcherCreateScreen', () => {
  const projectConst: LauncherBinding = {
    mode: 'project',
    categoryId: 'nodejs',
    projectName: 'AppJamatV3',
    projectPath: 'C:\\Projects\\NodeJs\\AppJamatV3',
  }

  afterEach(cleanup)

  function draw(state: CreateScreenState): ReturnType<typeof render> {
    return render(<LauncherCreateScreen state={state} dispatch={vi.fn()} />)
  }

  function opened(overrides: Partial<CreateScreenState> = {}): CreateScreenState {
    return { ...CreateScreenModel.opened(projectConst).state, ...overrides }
  }

  function nameField(view: ReturnType<typeof render>): HTMLInputElement {
    const field = view.container.querySelector<HTMLInputElement>('input[aria-label="Session name"]')
    if (field === null) throw new Error('the card drew no name field')
    return field
  }

  it('puts the caret in the name field as soon as that row is the one', () => {
    const view = draw(opened({ field: 'name' }))

    expect(document.activeElement).toBe(nameField(view))
  })

  it('leaves the caret alone while another row is the one', () => {
    const view = draw(opened({ field: 'type' }))

    expect(document.activeElement).not.toBe(nameField(view))
  })

  // The field is what tells the model the row moved, so the two cannot disagree about which row is
  // being edited - and focusing it again from the effect would fight whoever clicked elsewhere.
  it('tells the model the row moved when the field takes focus itself', () => {
    const dispatch = vi.fn()
    const view = render(
      <LauncherCreateScreen state={opened({ field: 'type' })} dispatch={dispatch} />,
    )

    fireEvent.focus(nameField(view))

    expect(dispatch).toHaveBeenCalledWith({ input: 'nameFocus' })
  })

  it('draws the number beside the field rather than inside it', () => {
    const view = draw(opened({ field: 'name', token: '015' }))

    expect(view.container.textContent).toContain('015 - ')
    expect(nameField(view).value).toBe('')
  })

  it('replaces Name and Isolation with Existing sessions and adds All to Agent', () => {
    const index = CreateScreenModel.typesOf({ tabProfile: false, target: { kind: 'local' } }).findIndex((type) => type.kind === 'existing')
    const state = CreateScreenModel.transition(opened(), { input: 'chooseType', index }).state
    const view = draw(state)
    const labels = [...view.container.querySelectorAll('.jamat-choice__label')]
      .map((node) => node.textContent)
    const cards = [...view.container.querySelectorAll('.jamat-choice__card-title')]
      .map((node) => node.textContent)

    expect(labels).toEqual(['Project', 'Type', 'Agent', 'Existing sessions'])
    expect(cards).toContain('All')
    expect(view.container.querySelector('[aria-label="Session name"]')).toBeNull()
    expect(view.container.textContent).not.toContain('Worktree')
    expect(view.container.querySelector('.jamat-launcher-create__sessions-field')).toBeTruthy()
  })

  /*
   * The model row is a REMOTE row: what a session started here runs on is this computer's setting,
   * and the place to change that is the settings tab. On a remote card the offer is the target's.
   */
  it('draws the target’s models on a remote card and no such row on a local one', () => {
    const remote = CreateScreenModel.transition(
      CreateScreenModel.opened(projectConst, {
        target: { kind: 'remote', remoteEndpointId: 'endpoint-a', displayName: 'Studio' },
      }).state,
      {
        input: 'agentsDescribed',
        remoteEndpointId: 'endpoint-a',
        agents: [{
          agentId: 'claude',
          configuredModel: 'opus',
          models: [{
            id: 'claude-fable-5',
            label: 'Claude Fable 5',
            kind: 'version',
            context: 200_000,
            efforts: ['high'],
          }],
        }],
      },
    ).state
    const view = draw(remote)
    const picker = view.container
      .querySelector<HTMLSelectElement>('select[aria-label="Model on the target computer"]')

    expect([...view.container.querySelectorAll('.jamat-choice__label')].map((node) =>
      node.textContent)).toEqual(['Project', 'Name', 'Type', 'Agent', 'Model'])
    // `opus` is what that computer is configured on and is not in the catalog it sent, so it is
    // drawn as a bare extra id: hiding it would show something else as chosen.
    expect([...picker?.options ?? []].map((option) => option.textContent))
      .toEqual(['Target default (opus)', 'Claude Fable 5', 'opus'])
    expect(draw(opened()).container.textContent).not.toContain('Model')
  })

  /* A refusal is drawn in words: a picker that is simply absent reads as one that was forgotten. */
  it('says why a target that does not offer model selection has no picker', () => {
    const refused = CreateScreenModel.transition(
      CreateScreenModel.opened(projectConst, {
        target: { kind: 'remote', remoteEndpointId: 'endpoint-a', displayName: 'Studio' },
      }).state,
      {
        input: 'agentsDescribeFailed',
        remoteEndpointId: 'endpoint-a',
        refused: true,
        detail: 'agents.describe is not allowed for remote-peer',
      },
    ).state
    const view = draw(refused)

    expect(view.container.querySelector('select[aria-label="Model on the target computer"]'))
      .toBeNull()
    expect(view.container.textContent)
      .toContain('Studio does not offer model selection; it starts on the model it has configured')
    expect(view.container.querySelector('.jamat-launcher-create__model-retry')).toBeNull()
  })

  it('draws Continue/Fork disabled with a reason outside a catalog project', () => {
    const state = CreateScreenModel.opened({ mode: 'adHoc', path: 'D:\\work' }).state
    const view = draw(state)
    const card = [...view.container.querySelectorAll<HTMLButtonElement>(
      '.jamat-choice__card',
    )].find((candidate) => candidate.textContent?.includes('Continue/Fork'))

    expect(card?.disabled).toBe(true)
    expect(card?.title).toBe('existing sessions need a catalog project')
  })
})
