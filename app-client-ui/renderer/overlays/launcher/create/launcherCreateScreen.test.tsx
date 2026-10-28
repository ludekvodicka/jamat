import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { LauncherBinding } from '../launcherBinding'
import { CreateScreenModel, type CreateScreenState, type CreateScreenInput } from './createScreenModel'
import { LauncherCreateScreen } from './launcherCreateScreen'

/**
 * The card itself, which the model tests beside this one cannot speak for: what is on screen, and
 * where the caret is. `N` marked the Name row and left the caret where it was, so everything typed
 * after it went to the key handler instead of into the field - `w` toggled the worktree, `n` marked
 * the row again, the rest were dropped - while the footer advertised the key as "Name".
 */
describe('app-client-ui/renderer/overlays/launcher/create/launcherCreateScreen', () => {
  it('draws no single-account picker and submits the active second account choice', () => {
    const main = { agentId: 'claude' as const, accountId: 'main', label: 'Main', isMain: true,
      state: 'active' as const, identity: null, profileProblem: null }
    const dispatch = vi.fn()
    const view = render(<LauncherCreateScreen state={opened({ accounts: [main] })} dispatch={dispatch} />)
    expect(view.queryByLabelText('Account')).toBeNull()
    view.rerender(<LauncherCreateScreen state={opened({ accounts: [main,
      { ...main, accountId: 'second', label: 'Second', isMain: false },
      { ...main, accountId: 'pending', label: 'Pending', isMain: false, state: 'pending-login' },
      { ...main, accountId: 'disabled', label: 'Disabled', isMain: false, state: 'disabled' }] })} dispatch={dispatch} />)
    const picker = view.getByLabelText('Account')
    expect([...picker.querySelectorAll('option')].map(option => option.textContent)).toEqual(['Main', 'Second'])
    fireEvent.change(picker, { target: { value: 'second' } })
    expect(dispatch).toHaveBeenCalledWith({ input: 'chooseAccount', accountId: 'second' })
  })

  it('shows Main as the submitted default when unavailable beside two active added accounts', () => {
    const main = { agentId: 'claude' as const, accountId: 'main', label: 'Main', isMain: true,
      state: 'needs-login' as const, identity: null, profileProblem: null }
    let state = CreateScreenModel.transition(opened({ field: 'agent' }), { input: 'accountsLoaded', remoteEndpointId: null,
      accounts: [main, { ...main, accountId: 'first', label: 'First', isMain: false, state: 'active' },
        { ...main, accountId: 'second', label: 'Second', isMain: false, state: 'active' }] }).state
    const dispatch = (input: CreateScreenInput) => {
      state = CreateScreenModel.transition(state, input).state
      view.rerender(<LauncherCreateScreen state={state} dispatch={dispatch} />)
    }
    const view = render(<LauncherCreateScreen state={state} dispatch={dispatch} />)
    const picker = view.getByLabelText('Account')
    if (!(picker instanceof HTMLSelectElement)) throw new Error('The card drew no account select')
    expect(picker.value).toBe('main')
    expect(picker.selectedOptions[0].textContent).toBe('Main (default)')
    expect(CreateScreenModel.specOf(state, null).agent).toEqual({ agentId: 'claude', mode: 'new' })
    fireEvent.change(picker, { target: { value: 'second' } })
    expect(picker.value).toBe('second')
    expect(picker.selectedOptions[0].textContent).toBe('Second')
    expect(CreateScreenModel.specOf(state, null).agent).toEqual({ agentId: 'claude', mode: 'new', accountId: 'second' })
  })

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

  it('previews the worktree folder and draws no branch line', () => {
    const view = draw(opened({ field: 'isolation', token: '015', name: 'session wizard', worktree: true }))
    const note = view.container.querySelector('.jamat-launcher-create__note')

    expect(note?.textContent).toBe(
      'Runs in .worktrees/015-session-wizard of its product group, catalog project or directory, from HEAD',
    )
    expect(view.container.textContent).not.toContain('Branch')
  })

  it('names the owner and the numbered folder once the library said where the worktree stands', () => {
    const preview = { kind: 'svn' as const, ownerDir: 'D:\w\ToolAlpha', owner: 'project' as const, token: '001' }
    const state = { ...CreateScreenModel.opened({ mode: 'adHoc', path: 'D:\w\ToolAlpha\src' }).state,
      field: 'isolation' as const, name: 'Alpha W3', worktree: true, worktreePlace: { status: 'ready' as const, path: 'D:\w\ToolAlpha\src', preview } }
    const note = draw(state).container.querySelector('.jamat-launcher-create__note')

    expect(note?.textContent).toBe('Runs in .worktrees/001-alpha-w3 of the catalog project D:\w\ToolAlpha, from HEAD')
  })

  it('replaces Name and Isolation with Existing sessions and adds All to Agent', () => {
    const index = CreateScreenModel.typesOf({ target: { kind: 'local' }, source: null }).findIndex((type) => type.kind === 'existing')
    const state = CreateScreenModel.transition(opened(), { input: 'chooseType', index }).state
    const view = draw(state)
    const labels = [...view.container.querySelectorAll('.jamat-choice__label')]
      .map((node) => node.textContent)
    const cards = [...view.container.querySelectorAll('.jamat-choice__card-title')]
      .map((node) => node.textContent)

    expect(labels).toEqual(['Project', 'Agent', 'Type', 'Existing sessions'])
    expect(cards).toContain('All')
    expect(view.container.querySelector('[aria-label="Session name"]')).toBeNull()
    expect(view.container.textContent).not.toContain('Worktree')
    expect(view.container.querySelector('.jamat-launcher-create__sessions-field')).toBeTruthy()
  })

  /*
   * The card `Fork session` opens: Continue/Fork, standing on the session it was opened on, with
   * the number drawn as the PAIR the title will carry. The isolation row is not drawn at all - a
   * session opened out of that list runs where it already runs - and the name row is, because a
   * fork is the one row of it that founds a session still to be called something.
   */
  it('stands on the session it was opened on and draws the number pair', () => {
    const state = CreateScreenModel.opened(projectConst, {
      name: 'the wire',
      source: {
        mode: 'fork',
        sessionId: 's-parent',
        agentId: 'claude',
        nativeSessionId: 'claude-1',
        number: '014',
        title: '014 - the wire',
        tabTitle: 'AppJamatV3 - the wire',
      },
    }).state
    const view = draw({ ...state, token: '015' })
    const labels = [...view.container.querySelectorAll('.jamat-choice__label')]
      .map((node) => node.textContent)

    expect(labels).toEqual(['Project', 'Name', 'Agent', 'Type', 'Existing sessions'])
    const rows = [...view.container.querySelectorAll('.jamat-launcher-create__session-row')]
      .map((row) => row.textContent)
    expect(rows).toEqual(['014 - the wirethis sessionC'])
    expect(rows[0]).toContain('this session')
    expect(view.container.textContent).toContain('014-015 - ')
    expect(view.container.textContent).toContain('Fork')
    expect(nameField(view).value).toBe('the wire')
    expect(view.container.textContent).not.toContain('runs in its own worktree')
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
      node.textContent)).toEqual(['Project', 'Name', 'Agent', 'Type', 'Model'])
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
