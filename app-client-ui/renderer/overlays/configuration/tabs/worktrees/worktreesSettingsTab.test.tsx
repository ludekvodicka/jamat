import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SetupFamilies } from '../../../../../../lib-orchestrator/projectSetup/setupFamilies'
import type { AppClientUiBridge } from '../../../../../shared/appClientUiIpc'
import { WorktreeSetupIntentStore } from '../../worktreeSetupIntentStore'
import { WorktreesSettingsTab } from './worktreesSettingsTab'

describe('app-client-ui/renderer/overlays/configuration/tabs/worktrees/worktreesSettingsTab', () => {
  type BridgeStub = { worktrees: AppClientUiBridge['worktrees'] }
  const intentConst = { projectName: 'AppJamatV3', projectPath: 'Q:/x/AppJamatV3' }

  afterEach(() => {
    cleanup()
    delete (window as unknown as { appClient?: unknown }).appClient
  })

  async function mount(answer: {
    ok?: boolean
    detail?: string
    intent?: boolean
    projectSetup?: string[] | null
    projectProblem?: string
  } = {}) {
    const saved: unknown[] = []
    const savedProject: unknown[] = []
    ;(window as unknown as { appClient: BridgeStub }).appClient = {
      worktrees: {
        getSettings: () => Promise.resolve({
          ok: true,
          value: { node: { pnpm: { globalVirtualStore: false } } },
        }),
        saveSettings: (value) => {
          saved.push(value)
          return Promise.resolve(answer.ok !== false
            ? { ok: true as const, value: { ok: true as const } }
            : {
              ok: true as const,
              value: {
                ok: false as const,
                code: 'config-latched' as const,
                detail: answer.detail ?? 'latched',
              },
            })
        },
        getProjectSetup: () => Promise.resolve({
          ok: true as const,
          value: answer.projectProblem === undefined
            ? { ok: true as const, setup: answer.projectSetup ?? null }
            : { ok: false as const, problem: answer.projectProblem },
        }),
        saveProjectSetup: (projectPath, setup) => {
          savedProject.push({ projectPath, setup })
          return Promise.resolve({ ok: true as const, value: { ok: true as const } })
        },
      },
    }
    const intents = new WorktreeSetupIntentStore()
    if (answer.intent === true) intents.write(intentConst)
    const onDirtyChange = vi.fn()
    const view = render(
      <WorktreesSettingsTab onDirtyChange={onDirtyChange} worktreeSetupIntents={intents} />,
    )
    // Twice: the section load and the project load are two round trips off the same mount.
    await act(async () => Promise.resolve())
    await act(async () => Promise.resolve())
    return { intents, onDirtyChange, saved, savedProject, view }
  }

  /* R1: the order is the mechanism, so the screen has to say it, not just obey it. */
  it('names the three tiers in the order that decides the command', async () => {
    const { view } = await mount()

    const tiers = [...view.container.querySelectorAll('.jamat-configuration-worktrees__tiers li')]
      .map((tier) => tier.textContent ?? '')
    expect(tiers).toHaveLength(3)
    expect(tiers[0]).toContain('.worktree.json')
    expect(tiers[0]).toContain('beats everything')
    expect(tiers[1]).toContain('this machine')
    expect(tiers[2]).toContain('default')
  })

  it('draws one row per family, out of the table that decides the command', async () => {
    const { view } = await mount()

    const rows = view.container.querySelectorAll('[data-family]')
    expect(rows).toHaveLength(SetupFamilies.catalogConst.length)
    for (const family of SetupFamilies.catalogConst) {
      const row = view.container.querySelector(`[data-family="${family.familyId}"]`)
      for (const tool of family.tools)
        expect(row?.textContent, tool.toolId).toContain(tool.command)
    }
  })

  it('loads the stored switch and saves the one the user moved', async () => {
    const { onDirtyChange, saved, view } = await mount()
    const checkbox = view.container.querySelector('input[type="checkbox"]')!
    expect((checkbox as HTMLInputElement).checked).toBe(false)

    await act(async () => { fireEvent.click(checkbox) })
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)

    const save = [...view.container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Save')!
    await act(async () => { fireEvent.click(save) })

    expect(saved).toEqual([{ node: { pnpm: { globalVirtualStore: true } } }])
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)
  })

  it('keeps the buffer and says why when the store refuses the write', async () => {
    const { view } = await mount({ ok: false, detail: 'config.json is latched' })
    const checkbox = view.container.querySelector('input[type="checkbox"]')!

    await act(async () => { fireEvent.click(checkbox) })
    const save = [...view.container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Save')!
    await act(async () => { fireEvent.click(save) })

    expect(view.container.querySelector('[role="alert"]')?.textContent)
      .toContain('config.json is latched')
    expect((view.container.querySelector('input[type="checkbox"]') as HTMLInputElement).checked)
      .toBe(true)
  })

  it('names the command the switch turns on, so nobody has to guess what it does', async () => {
    const { view } = await mount()
    expect(view.container.textContent)
      .toContain(SetupFamilies.pnpmGlobalVirtualStoreCommandConst)
  })

  describe('the project half, when a right-click named one', () => {
    it('shows nothing about a project when nobody named one', async () => {
      const { view } = await mount()
      expect(view.container.querySelector('textarea')).toBeNull()
      expect(view.container.textContent).not.toContain('AppJamatV3')
    })

    it('names the project and loads what it declares', async () => {
      const { view } = await mount({ intent: true, projectSetup: ['pnpm install', './boot.sh'] })
      expect(view.container.textContent).toContain('AppJamatV3')
      expect((view.container.querySelector('textarea') as HTMLTextAreaElement).value)
        .toBe(['pnpm install', './boot.sh'].join('\n'))
    })

    it('writes the lines that were typed, one command per line', async () => {
      const { savedProject, view } = await mount({ intent: true, projectSetup: [] })
      const box = view.container.querySelector('textarea')!
      const typed = ['pnpm i', '', '  ./boot.sh  '].join('\n')
      await act(async () => { fireEvent.change(box, { target: { value: typed } }) })
      const save = [...view.container.querySelectorAll('button')]
        .find((button) => button.textContent === 'Save .worktree.json')!
      await act(async () => { fireEvent.click(save) })
      expect(savedProject).toEqual([
        { projectPath: intentConst.projectPath, setup: ['pnpm i', './boot.sh'] },
      ])
    })

    it('offers no editor over a file that could not be read, and says why', async () => {
      const { view } = await mount({ intent: true, projectProblem: 'is not valid JSON' })
      expect(view.container.querySelector('textarea')).toBeNull()
      expect(view.container.querySelector('[role="alert"]')?.textContent)
        .toContain('not valid JSON')
    })

    /* The whole point of the store: a card opened later must not still edit last week's project. */
    it('consumes the intent, so a second card opens on the machine half alone', async () => {
      const { intents } = await mount({ intent: true, projectSetup: [] })
      expect(intents.consume()).toBeNull()
    })
  })

  it('ignores a failed machine save after the tab was retired', async () => {
    let finish = (): void => undefined
    ;(window as unknown as { appClient: BridgeStub }).appClient = {
      worktrees: {
        getSettings: async () => ({
          ok: true,
          value: { node: { pnpm: { globalVirtualStore: false } } },
        }),
        saveSettings: () => new Promise((resolve) => {
          finish = () => resolve({
            ok: true,
            value: { ok: false, code: 'config-latched', detail: 'late refusal' },
          })
        }),
        getProjectSetup: async () => ({ ok: true, value: { ok: true, setup: null } }),
        saveProjectSetup: async () => ({ ok: true, value: { ok: true } }),
      },
    }
    const onDirtyChange = vi.fn()
    const view = render(<WorktreesSettingsTab onDirtyChange={onDirtyChange} />)
    await act(async () => Promise.resolve())
    fireEvent.click(view.container.querySelector('input[type="checkbox"]')!)
    fireEvent.click([...view.container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Save')!)
    view.unmount()

    await act(async () => finish())

    expect(onDirtyChange.mock.calls).toEqual([[true], [false]])
  })
})
