import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LauncherFixtures } from '../fixtures/launcherFixtures'
import type { LauncherBinding } from '../launcherBinding'
import { CreateScreenModel, type CreateScreenState } from './createScreenModel'
import { ExistingSessions } from './existingSessions'

describe('app-client-ui/renderer/overlays/launcher/create/existingSessions', () => {
  const projectConst: LauncherBinding = {
    mode: 'project',
    categoryId: 'nodejs',
    projectName: 'AppJamatV3',
    projectPath: 'C:/Projects/NodeJs/AppJamatV3',
  }

  afterEach(cleanup)

  function state(): CreateScreenState {
    const opened = CreateScreenModel.opened(projectConst)
    const index = CreateScreenModel.typesOf({ tabProfile: false, target: { kind: 'local' }, source: null }).findIndex((type) => type.kind === 'existing')
    const typed = CreateScreenModel.transition(opened.state, { input: 'chooseType', index })
    return CreateScreenModel.transition(typed.state, {
      input: 'existingSessionsLoaded',
      categoryId: 'nodejs',
      projectName: 'AppJamatV3',
      summaries: LauncherFixtures.history(),
    }).state
  }

  it('draws the same title, activity time, live state and provider identity as the history row', () => {
    const active = {
      ...LauncherFixtures.history()[0]!,
      active: true,
      localTitle: '014 - Rewrite the launcher',
      createdAt: Date.UTC(2026, 7, 5, 8, 22),
      lastActivity: Date.UTC(2026, 7, 5, 11, 22),
    }
    const current = { ...state(), existingSessions: [active] }
    const view = render(
      <ExistingSessions
        state={current}
        now={Date.UTC(2026, 7, 5, 12, 0)}
        dispatch={vi.fn()}
      />,
    )

    expect(view.container.querySelector('.jamat-launcher__name')?.textContent)
      .toBe('014 - Rewrite the launcher')
    expect([...view.container.querySelectorAll('.jamat-launcher-create__session-time > span')]
      .map((line) => line.textContent)).toEqual(['38 min ago', '(3 h old)'])
    expect(view.container.querySelector('.jamat-launcher-create__session-row'))
      .toHaveClass('jamat-launcher__row--selected')
    expect(view.container.querySelector('.jamat-launcher-create__session-live')).toBeTruthy()
    expect(view.container.querySelector('.jamat-launcher__agent--claude')?.textContent).toBe('C')
  })

  it('selects on click and activates on double click', () => {
    const dispatch = vi.fn()
    const view = render(<ExistingSessions state={state()} now={Date.now()} dispatch={dispatch} />)
    const rows = view.container.querySelectorAll('[role="option"]')

    fireEvent.click(rows[1]!)
    fireEvent.doubleClick(rows[1]!)

    expect(dispatch).toHaveBeenCalledWith({ input: 'setExistingCursor', index: 1 })
    expect(dispatch).toHaveBeenCalledWith({ input: 'activate' })
  })

  it('draws only the provider selected in Agent', () => {
    const current = CreateScreenModel.transition(state(), {
      input: 'chooseExistingAgent',
      agentId: 'codex',
    }).state
    const view = render(<ExistingSessions state={current} now={Date.now()} dispatch={vi.fn()} />)

    expect([...view.container.querySelectorAll('.jamat-launcher__name')]
      .map((node) => node.textContent)).toEqual(['Worktree cleanup'])
  })
})
