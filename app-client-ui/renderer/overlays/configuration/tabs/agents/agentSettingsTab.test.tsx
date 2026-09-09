import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AgentModels } from '../../../../../shared/agentModels'
import type { AgentSettingsValue } from '../../../../../shared/agentSettings'
import type { AppClientUiBridge } from '../../../../../shared/appClientUiIpc'
import { AgentSettingsTab } from './agentSettingsTab'

describe('app-client-ui/renderer/overlays/configuration/tabs/agents/agentSettingsTab', () => {
  type BridgeStub = { agents: Pick<AppClientUiBridge['agents'], 'getSettings' | 'saveSettings'> }
  type ProviderLabel = 'Claude' | 'Codex'
  type View = ReturnType<typeof render>

  afterEach(() => {
    cleanup()
    delete (window as unknown as { appClient?: unknown }).appClient
  })

  async function mount(stored: AgentSettingsValue, refusal?: string) {
    const saved: unknown[] = []
    ;(window as unknown as { appClient: BridgeStub }).appClient = {
      agents: {
        getSettings: () => Promise.resolve({ ok: true, value: stored }),
        saveSettings: (value) => {
          saved.push(value)
          return Promise.resolve(refusal === undefined
            ? { ok: true as const, value: { ok: true as const } }
            : {
              ok: true as const,
              value: { ok: false as const, code: 'section-damaged' as const, detail: refusal },
            })
        },
      },
    }
    const onDirtyChange = vi.fn()
    const view = render(<AgentSettingsTab onDirtyChange={onDirtyChange} />)
    await act(async () => Promise.resolve())
    return { onDirtyChange, saved, view }
  }

  function selectProvider(view: View, label: ProviderLabel): void {
    fireEvent.click(view.getByRole('tab', { name: label }))
  }

  function yoloOf(view: View, label: ProviderLabel): HTMLInputElement {
    selectProvider(view, label)
    return view.getByLabelText(`${label} - run in yolo mode`) as HTMLInputElement
  }

  it('opens Claude and switches to an isolated Codex panel', async () => {
    const { onDirtyChange, saved, view } = await mount({
      claude: { yolo: false },
      codex: { yolo: false },
    })
    const tabs = view.getAllByRole('tab')
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Claude', 'Codex'])
    expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual(['true', 'false'])
    expect(view.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(tabs[0]!.id)
    expect(view.queryByLabelText('Codex - run in yolo mode')).toBeNull()

    fireEvent.click(yoloOf(view, 'Claude'))
    expect(onDirtyChange).toHaveBeenCalledWith(true)
    selectProvider(view, 'Codex')
    expect(view.queryByLabelText('Claude - run in yolo mode')).toBeNull()
    expect(yoloOf(view, 'Codex').checked).toBe(false)
    expect(yoloOf(view, 'Claude').checked).toBe(true)
    await act(async () => { fireEvent.click(view.getByText('Save')) })

    expect(saved).toEqual([{ claude: { yolo: true }, codex: { yolo: false } }])
    expect(onDirtyChange.mock.calls).toEqual([[true], [false]])
  })

  it('shows a stored yolo and turns it back off', async () => {
    const { saved, view } = await mount({ claude: { yolo: true }, codex: { yolo: true } })
    expect(yoloOf(view, 'Claude').checked).toBe(true)
    const codex = yoloOf(view, 'Codex')
    expect(codex.checked).toBe(true)

    fireEvent.click(codex)
    await act(async () => { fireEvent.click(view.getByText('Save')) })

    expect(saved).toEqual([{ claude: { yolo: true }, codex: { yolo: false } }])
  })

  it('puts a refused save on screen and keeps the pending choice', async () => {
    const { view } = await mount(
      { claude: { yolo: false }, codex: { yolo: false } },
      'repair it by hand',
    )
    fireEvent.click(yoloOf(view, 'Claude'))
    await act(async () => { fireEvent.click(view.getByText('Save')) })

    expect(view.getByRole('alert').textContent).toContain('repair it by hand')
    expect(yoloOf(view, 'Claude').checked).toBe(true)
  })

  // The one thing the switch cannot do for the user, so the tab has to say who does it.
  it('names the setting Jamat will not write on their behalf', async () => {
    const { view } = await mount({ claude: { yolo: false }, codex: { yolo: false } })

    expect(view.container.textContent).toContain('skipDangerousModePermissionPrompt')
    expect(view.container.textContent).toContain('~/.claude/settings.json')
    selectProvider(view, 'Codex')
    expect(view.container.textContent).not.toContain('skipDangerousModePermissionPrompt')
  })

  it('resets both agents without writing', async () => {
    const { saved, view } = await mount({ claude: { yolo: true }, codex: { yolo: true } })

    selectProvider(view, 'Codex')
    fireEvent.click(view.getByText('Reset to default'))

    expect(yoloOf(view, 'Claude').checked).toBe(false)
    expect(yoloOf(view, 'Codex').checked).toBe(false)
    expect(saved).toEqual([])
  })

  describe('context compaction', () => {
    function percentagesOf(view: View): HTMLInputElement[] {
      return [...view.container.querySelectorAll<HTMLInputElement>('input[type="number"]')]
    }

    function automaticOf(view: View, label: ProviderLabel): HTMLInputElement {
      selectProvider(view, label)
      return view.getByLabelText(`${label} - enable auto-compact`) as HTMLInputElement
    }

    it('draws the provider defaults over an old config', async () => {
      const { view } = await mount({ claude: { yolo: false }, codex: { yolo: false } })

      expect(percentagesOf(view).map((field) => field.value)).toEqual(['35', '40'])
      expect(automaticOf(view, 'Claude').checked).toBe(false)
      selectProvider(view, 'Codex')
      expect(percentagesOf(view).map((field) => field.value)).toEqual(['60', '75'])
      expect(automaticOf(view, 'Codex').checked).toBe(false)
      expect(view.container.textContent).toContain('working turn becomes idle')
    })

    it('saves one provider thresholds and switch beside its existing settings', async () => {
      const { saved, view } = await mount({
        claude: { yolo: true, model: 'opus' },
        codex: { yolo: false, effort: 'max' },
      })
      const percentages = percentagesOf(view)

      fireEvent.change(percentages[0]!, { target: { value: '70' } })
      fireEvent.change(percentages[1]!, { target: { value: '90' } })
      fireEvent.click(automaticOf(view, 'Claude'))
      await act(async () => { fireEvent.click(view.getByText('Save')) })

      expect(saved).toEqual([{
        claude: {
          yolo: true,
          model: 'opus',
          contextPanelPercent: 70,
          autoCompactPercent: 90,
          autoCompactEnabled: true,
        },
        codex: { yolo: false, effort: 'max' },
      }])
    })

    it('removes explicit context values when reset returns to defaults', async () => {
      const { view } = await mount({
        claude: {
          yolo: false,
          contextPanelPercent: 60,
          autoCompactPercent: 80,
          autoCompactEnabled: true,
        },
        codex: { yolo: false },
      })

      fireEvent.click(view.getByText('Reset to default'))

      expect(percentagesOf(view).map((field) => field.value)).toEqual(['35', '40'])
      expect(automaticOf(view, 'Claude').checked).toBe(false)
      selectProvider(view, 'Codex')
      expect(percentagesOf(view).map((field) => field.value)).toEqual(['60', '75'])
      expect(automaticOf(view, 'Codex').checked).toBe(false)
    })
  })

  describe('default model', () => {
    function fieldOf(view: View, label: ProviderLabel): HTMLInputElement {
      selectProvider(view, label)
      return view.getByLabelText(`${label} - default model`) as HTMLInputElement
    }

    it('draws an empty field per agent, naming what an empty one means', async () => {
      const { view } = await mount({ claude: { yolo: false }, codex: { yolo: false } })
      const claude = fieldOf(view, 'Claude')
      const codex = fieldOf(view, 'Codex')

      expect([claude.value, codex.value]).toEqual(['', ''])
      expect(claude.placeholder).toBe("agent's own default")
      expect(view.container.textContent).toContain('starts on its own default')
    })

    it('shows a stored model and saves only the one that moved', async () => {
      const { onDirtyChange, saved, view } = await mount({
        claude: { yolo: false, model: 'opus' },
        codex: { yolo: true, model: 'gpt-5.5' },
      })
      expect(fieldOf(view, 'Claude').value).toBe('opus')
      const codex = fieldOf(view, 'Codex')
      expect(codex.value).toBe('gpt-5.5')

      fireEvent.change(codex, { target: { value: 'gpt-5.6-sol' } })
      expect(onDirtyChange).toHaveBeenCalledWith(true)
      await act(async () => { fireEvent.click(view.getByText('Save')) })

      expect(saved).toEqual([{
        claude: { yolo: false, model: 'opus' },
        codex: { yolo: true, model: 'gpt-5.6-sol' },
      }])
    })

    // Emptying the field must store the ABSENCE of an opinion, never an empty model.
    it('clears a model to no key at all', async () => {
      const { saved, view } = await mount({
        claude: { yolo: false, model: 'opus' },
        codex: { yolo: false },
      })

      fireEvent.change(fieldOf(view, 'Claude'), { target: { value: '' } })
      await act(async () => { fireEvent.click(view.getByText('Save')) })

      expect(saved).toEqual([{ claude: { yolo: false }, codex: { yolo: false } }])
      expect('model' in (saved[0] as { claude: object }).claude).toBe(false)
    })

    it('puts a refused model on screen and keeps what was typed', async () => {
      const { view } = await mount(
        { claude: { yolo: false }, codex: { yolo: false } },
        'agents must hold { claude: { yolo: boolean, model?: string }, codex: the same }',
      )

      fireEvent.change(fieldOf(view, 'Claude'), { target: { value: 'gpt 5' } })
      await act(async () => { fireEvent.click(view.getByText('Save')) })

      expect(view.getByRole('alert').textContent).toContain('model?: string')
      expect(fieldOf(view, 'Claude').value).toBe('gpt 5')
    })

    function listOf(view: View, field: HTMLInputElement): string[] {
      const list = view.container.querySelector<HTMLDataListElement>(`datalist#${field.getAttribute('list')}`)
      return [...(list?.querySelectorAll('option') ?? [])].map((option) => option.value)
    }

    it('suggests each agent its own models and nobody else\'s', async () => {
      const { view } = await mount({ claude: { yolo: false }, codex: { yolo: false } })
      const claude = fieldOf(view, 'Claude')
      const claudeList = listOf(view, claude)
      const codex = fieldOf(view, 'Codex')
      const codexList = listOf(view, codex)

      expect(claude.getAttribute('list')).not.toBe(codex.getAttribute('list'))
      expect(claudeList).toEqual(
        AgentModels.optionsFor('claude').map((option) => option.id),
      )
      expect(codexList).toEqual(
        AgentModels.optionsFor('codex').map((option) => option.id),
      )
      expect(codexList).not.toContain('codex-auto-review')
      expect(codexList).not.toContain('opus')
    })

    // The detail line and NOT `container.textContent`: suggestions in the active datalist are text
    // in this container too, and one of those labels is literally `(1M context)`.
    function detailsOf(view: View): string[] {
      return [...view.container.querySelectorAll('.jamat-configuration-agents__model-detail')]
        .map((line) => line.textContent ?? '')
    }

    it('describes the model in the field, and only on an exact id', async () => {
      const { view } = await mount({
        claude: { yolo: false, model: 'opus' },
        codex: { yolo: false, model: 'gpt-5.6-sol' },
      })

      expect(detailsOf(view)).toEqual([
        '200k context · effort: low, medium, high, xhigh, max · always the newest Opus',
      ])
      selectProvider(view, 'Codex')
      expect(detailsOf(view)).toEqual([
        '272k context · effort: low, medium, high, xhigh, max, ultra'
          + ' · Latest frontier agentic coding model.',
      ])

      // A model nobody in the list names is still storable, so the line is silent rather than wrong.
      const claude = fieldOf(view, 'Claude')
      fireEvent.change(claude, { target: { value: 'claude-opus-9' } })
      expect(detailsOf(view)).toHaveLength(0)
      expect(claude.value).toBe('claude-opus-9')
    })

    it('reads the million off the suffix the way the transcript reader does', async () => {
      const { view } = await mount({
        claude: { yolo: false, model: 'claude-opus-5[1m]' },
        codex: { yolo: false },
      })
      const bare = await mount({
        claude: { yolo: false, model: 'claude-opus-5' },
        codex: { yolo: false },
      })

      expect(detailsOf(view)[0]).toContain('1M context')
      expect(detailsOf(bare.view)[0]).toContain('200k context')
    })

    it('says nothing about effort for a model that takes none', async () => {
      const { view } = await mount({
        claude: { yolo: false, model: 'claude-haiku-4-5-20251001' },
        codex: { yolo: false },
      })

      expect(detailsOf(view)).toEqual(['200k context'])
    })

    it('empties both fields when reset says default', async () => {
      const { saved, view } = await mount({
        claude: { yolo: true, model: 'opus' },
        codex: { yolo: true, model: 'gpt-5.5' },
      })

      fireEvent.click(view.getByText('Reset to default'))

      expect(fieldOf(view, 'Claude').value).toBe('')
      expect(fieldOf(view, 'Codex').value).toBe('')
      expect(saved).toEqual([])
    })
  })

  describe('default effort', () => {
    function selectOf(view: View, label: ProviderLabel): HTMLSelectElement {
      selectProvider(view, label)
      return view.getByLabelText(`${label} - default effort`) as HTMLSelectElement
    }

    function levelsOf(select: HTMLSelectElement): string[] {
      return [...select.querySelectorAll('option')].map((option) => option.value).filter(Boolean)
    }

    it('offers the levels of the model that was chosen, per agent', async () => {
      const { view } = await mount({
        claude: { yolo: false, model: 'claude-haiku-4-5-20251001' },
        codex: { yolo: false, model: 'gpt-5.6-sol' },
      })
      const claude = selectOf(view, 'Claude')

      // Haiku takes no effort at all, so there is nothing to choose and the control says so.
      expect(levelsOf(claude)).toEqual([])
      expect(claude.disabled).toBe(true)
      expect(view.container.textContent).toContain('takes no effort level')

      // Only the 5.6 models take `ultra`, and Codex answers 400 on a level its model refuses.
      const codex = selectOf(view, 'Codex')
      expect(levelsOf(codex)).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
      expect(codex.disabled).toBe(false)
    })

    it('falls back to the agent\'s own levels while no model is chosen', async () => {
      const { view } = await mount({ claude: { yolo: false }, codex: { yolo: false } })
      const claude = selectOf(view, 'Claude')
      const codex = selectOf(view, 'Codex')

      expect(levelsOf(claude)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
      expect(levelsOf(codex)).toContain('ultra')
      expect(claude.disabled).toBe(false)
    })

    it('saves a chosen level and clears it back to no key at all', async () => {
      const { onDirtyChange, saved, view } = await mount({
        claude: { yolo: false, model: 'opus' },
        codex: { yolo: false },
      })
      const claude = selectOf(view, 'Claude')
      expect(claude.value).toBe('')

      fireEvent.change(claude, { target: { value: 'xhigh' } })
      expect(onDirtyChange).toHaveBeenCalledWith(true)
      await act(async () => { fireEvent.click(view.getByText('Save')) })

      expect(saved).toEqual([{
        claude: { yolo: false, model: 'opus', effort: 'xhigh' },
        codex: { yolo: false },
      }])

      fireEvent.change(selectOf(view, 'Claude'), { target: { value: '' } })
      await act(async () => { fireEvent.click(view.getByText('Save')) })
      expect('effort' in (saved[1] as { claude: object }).claude).toBe(false)
    })

    // A level the chosen model does not offer would otherwise vanish from the control while
    // config.json still held it, and the select would read as the agent's own default.
    it('keeps a stored level visible even when the model does not offer it', async () => {
      const { view } = await mount({
        claude: { yolo: false, model: 'opus', effort: 'ultra' },
        codex: { yolo: false },
      })

      expect(selectOf(view, 'Claude').value).toBe('ultra')
      expect(view.container.textContent).toContain('not offered by this model')
    })

    it('drops the effort along with everything else when reset says default', async () => {
      const { saved, view } = await mount({
        claude: { yolo: true, model: 'opus', effort: 'high' },
        codex: { yolo: false, effort: 'low' },
      })

      fireEvent.click(view.getByText('Reset to default'))

      expect(selectOf(view, 'Claude').value).toBe('')
      expect(selectOf(view, 'Codex').value).toBe('')
      await act(async () => { fireEvent.click(view.getByText('Save')) })
      expect(saved).toEqual([{ claude: { yolo: false }, codex: { yolo: false } }])
    })
  })
})
