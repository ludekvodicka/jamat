import { describe, expect, it } from 'vitest'

import { CreateScreenModel, type CreateScreenState } from '../create/createScreenModel'
import type { LauncherBinding } from '../launcherBinding'
import type { FlowScreenInput, FlowScreenState, FlowScreenStep } from './flowScreenModel'
import { FlowScreenModel } from './flowScreenModel'

describe('app-client-ui/renderer/overlays/launcher/flows/flowScreenModel', () => {
  const projectConst: LauncherBinding = {
    mode: 'project',
    categoryId: 'nodejs',
    projectName: 'AppJamatV3',
    projectPath: 'C:\\Projects\\NodeJs\\AppJamatV3',
  }

  function options(
    binding: LauncherBinding = projectConst,
    overrides: Partial<CreateScreenState> = {},
  ): CreateScreenState {
    return {
      ...CreateScreenModel.opened(binding).state,
      token: '015',
      ...overrides,
    }
  }

  class Run {
    private constructor(public step: FlowScreenStep) {}

    static opened(created: CreateScreenState = options()): Run {
      return new Run(FlowScreenModel.opened('feature-request', created))
    }

    /** The form as somebody who finished filling it in would leave it. */
    static filled(created: CreateScreenState = options()): Run {
      return Run.opened(created).on(
        { input: 'formInput', value: { field: 'summary', value: 'Merge a worktree back' } },
        { input: 'formInput', value: { field: 'description', value: 'It has no way home.' } },
      )
    }

    on(...inputs: readonly FlowScreenInput[]): Run {
      let step = this.step
      for (const input of inputs)
        step = FlowScreenModel.transition(step.state, input)
      return new Run(step)
    }

    get state(): FlowScreenState {
      return this.step.state
    }

    get effects(): FlowScreenStep['effects'] {
      return this.step.effects
    }
  }

  it('opens on the flow initial state and asks for nothing', () => {
    const run = Run.opened()

    expect(run.state.form).toEqual({ summary: '', description: '', acceptance: '' })
    expect(run.effects).toEqual([])
  })

  /** The same invariant the two screens beside it keep: Enter reports rather than refusing. */
  it('reports the problem instead of submitting an unfinished form', () => {
    const run = Run.opened().on({ input: 'activate' })

    expect(run.effects).toEqual([])
    expect(run.state.problem).toBe('a summary is what the session gets as its first instruction')
    expect(run.state.submitting).toBe(false)
  })

  it('clears the problem as soon as the field it was about is typed into', () => {
    const run = Run.opened()
      .on({ input: 'activate' })
      .on({ input: 'formInput', value: { field: 'summary', value: 'A' } })

    expect(run.state.problem).toBeNull()
  })

  it('submits once the form composes', () => {
    const run = Run.filled().on({ input: 'activate' })

    expect(run.effects).toEqual([{ effect: 'submit' }])
    expect(run.state.submitting).toBe(true)
  })

  /*
   * The success path of a submit calls `openTerminal` and `close` whatever screen is up, so backing
   * out of a slow one - a worktree plus an install, with nothing apparently happening - opened a tab
   * for a session the person believed they had cancelled. The footer already says "Starting…".
   */
  /*
   * Escape here goes back to the create card, whose own answers travel back with it (`showCreate`
   * takes `options`). The flow's did not: a paragraph of description and acceptance criteria went
   * with one keystroke and there was no way back to it. Whoever holds the screens holds the last
   * form; this only has to be able to take it.
   */
  it('opens on the form it was handed rather than on an empty one', () => {
    const typed = Run.filled().state.form

    const reopened = FlowScreenModel.opened('feature-request', options(), typed)

    expect(reopened.state.form).toEqual(typed)
  })

  it('opens on an empty form where it was handed none', () => {
    const fresh = FlowScreenModel.opened('feature-request', options())
    const typed = Run.filled().state.form

    expect(fresh.state.form).not.toEqual(typed)
  })

  it('cannot be escaped while a submit is out', () => {
    const submitting = Run.filled().on({ input: 'activate' })
    expect(submitting.state.submitting).toBe(true)

    const escaped = FlowScreenModel.transition(submitting.state, { input: 'escape' })

    expect(escaped.effects).toEqual([])
    expect(escaped.state.submitting).toBe(true)
  })

  it('is escaped as before while nothing is out', () => {
    expect(FlowScreenModel.transition(Run.filled().state, { input: 'escape' }).effects)
      .toEqual([{ effect: 'back' }])
  })

  it('takes a second Enter as nothing while the first is still in flight', () => {
    expect(Run.filled().on({ input: 'activate' }, { input: 'activate' }).effects).toEqual([])
  })

  it('puts the composed prompt and the flow id on the spec', () => {
    const spec = FlowScreenModel.specOf(Run.filled().state, '015')

    expect(spec.kind).toBe('agent')
    expect(spec.flowId).toBe('feature-request')
    expect(spec.agent?.initialPrompt).toContain('# Merge a worktree back')
    expect(spec.agent?.mode).toBe('new')
  })

  /** The flow proposes a title; a name typed on the create screen is about THIS session and wins. */
  it('titles the session from the summary, unless a name was already typed', () => {
    expect(FlowScreenModel.specOf(Run.filled().state, '015').title)
      .toBe('015 - Merge a worktree back')
    expect(FlowScreenModel.specOf(Run.filled(options(projectConst, { name: 'my own' })).state, '015')
      .title).toBe('015 - my own')
  })

  it('takes the flow suggestion of a worktree, and the branch carries the number', () => {
    const spec = FlowScreenModel.specOf(Run.filled().state, '015')
    expect(spec.worktree).toEqual({ slug: '015 - Merge a worktree back' })
  })

  /**
   * A suggestion cannot put a worktree somewhere one is refused. The flow does not know where the
   * session will run; the create screen's own rules still decide.
   */
  it('drops the suggested worktree where the binding cannot carry one', () => {
    const adHoc = options({ mode: 'adHoc', path: 'D:\\work' }, { token: null })
    expect(FlowScreenModel.specOf(Run.filled(adHoc).state, null).worktree).toBeUndefined()
  })

  it('keeps a worktree the person had already chosen', () => {
    const chosen = options(projectConst, { worktree: true })
    expect(FlowScreenModel.specOf(Run.filled(chosen).state, '015').worktree).toBeTruthy()
  })

  it('refuses to build a spec from a form that does not compose', () => {
    expect(() => FlowScreenModel.specOf(Run.opened().state, '015'))
      .toThrow(/Refusing to build a spec from an unfinished flow/)
  })

  it('keeps a refused create on the screen in the library words', () => {
    const run = Run.filled()
      .on({ input: 'activate' }, { input: 'submitFailed', code: 'dirty', detail: 'uncommitted' })

    expect(run.state.submitting).toBe(false)
    expect(run.state.submitError).toEqual({ code: 'dirty', detail: 'uncommitted', setup: undefined })
  })

  it('answers the setup refusal by submitting again with the hash it was shown', () => {
    const run = Run.filled().on(
      { input: 'activate' },
      {
        input: 'submitFailed',
        code: 'setup-not-acknowledged',
        detail: 'asks to run its own commands',
        setup: { commands: ['pnpm install'], hash: 'abc' },
      },
      { input: 'acknowledgeSetup' },
    )

    expect(run.effects).toEqual([{ effect: 'submit' }])
    expect(FlowScreenModel.specOf(run.state, '015').acknowledgeSetup).toBe('abc')
  })

  it('goes back on escape', () => {
    expect(Run.filled().on({ input: 'escape' }).effects).toEqual([{ effect: 'back' }])
  })

  it('throws on an input it does not know', () => {
    expect(() => FlowScreenModel.transition(
      Run.opened().state,
      { input: 'nope' } as unknown as FlowScreenInput,
    )).toThrow(/Unknown flow screen input/)
  })
})
