import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CreateScreenModel, type CreateScreenState } from '../create/createScreenModel'
import type { LauncherBinding } from '../launcherBinding'
import { LauncherFlowScreen } from './launcherFlowScreen'
import { FlowScreenModel, type FlowScreenState } from './flowScreenModel'

/**
 * The first flow's card. The model beside this one says what a form means; this says what is on
 * screen and what typing into it reports - the half that let a keyboard-first overlay ship a form
 * only a mouse could fill.
 */
describe('app-client-ui/renderer/overlays/launcher/flows/launcherFlowScreen', () => {
  const projectConst: LauncherBinding = {
    mode: 'project',
    categoryId: 'nodejs',
    projectName: 'AppJamatV3',
    projectPath: 'C:\\Projects\\NodeJs\\AppJamatV3',
  }

  afterEach(cleanup)

  function options(): CreateScreenState {
    return { ...CreateScreenModel.opened(projectConst).state, token: '015' }
  }

  function state(): FlowScreenState {
    return FlowScreenModel.opened('feature-request', options()).state
  }

  function draw(value: FlowScreenState = state()): {
    view: ReturnType<typeof render>
    dispatch: ReturnType<typeof vi.fn>
  } {
    const dispatch = vi.fn()
    return { view: render(<LauncherFlowScreen state={value} dispatch={dispatch} />), dispatch }
  }

  /*
   * Three fields, and the reason Tab had to stop being swallowed: a summary and two textareas is a
   * form, and a keyboard user could reach the first of them and nothing else.
   */
  it('draws every field of the flow, each one reachable', () => {
    const { view } = draw()

    const fields = view.container.querySelectorAll('input, textarea')
    expect(fields.length).toBeGreaterThanOrEqual(3)
    for (const field of fields)
      expect((field as HTMLElement).tabIndex).toBeGreaterThanOrEqual(0)
  })

  it('reports what is typed into a field as that field', () => {
    const { view, dispatch } = draw()
    const first = view.container.querySelector('input, textarea')
    if (first === null) throw new Error('the card drew no fields')

    fireEvent.change(first, { target: { value: 'Merge a worktree back' } })

    expect(dispatch).toHaveBeenCalledTimes(1)
    const [input] = dispatch.mock.calls[0] as [{ input: string; value: { field: string } }]
    expect(input.input).toBe('formInput')
    expect(typeof input.value.field).toBe('string')
  })

  it('says where the session will run and what the card before it chose', () => {
    const { view } = draw()

    expect(view.container.textContent).toContain('AppJamatV3')
    expect(view.container.textContent).toContain('015')
  })

  /** A submit that is out says so, which is what a screen that cannot be left has to say. */
  it('says a submit is under way rather than looking idle', () => {
    const { view } = draw({ ...state(), submitting: true })

    expect(view.container.textContent).toMatch(/Starting|…/)
  })
})
