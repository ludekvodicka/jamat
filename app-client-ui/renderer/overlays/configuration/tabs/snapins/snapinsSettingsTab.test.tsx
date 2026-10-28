import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SnapinsSettingsView } from '../../../../../../lib-orchestrator/snapins/snapinsApi.types'
import { AppControl } from '../../../../ipc/appControl'
import { SnapinsSettingsTab } from './snapinsSettingsTab'

const view: SnapinsSettingsView = { settings: { limit: 4, agents: ['claude'], workerPrompts: {}, kinds: { future: { value: 'keep' } } },
  kinds: [{ kind: 'review-todos', title: 'Review todos', fields: [{ kind: 'choicePerRow', id: 'modes', label: 'Project mode',
    rows: [{ key: 'project', label: 'Project', value: 'wt' }], options: [{ value: 'wt', label: 'WT' }, { value: 'wc', label: 'WC' }] }] }] }
beforeEach(() => {
  vi.spyOn(AppControl, 'value').mockResolvedValue({ ok: true, value: structuredClone(view) } as never)
  vi.spyOn(AppControl, 'library').mockResolvedValue({ ok: true, value: { ok: true, value: { saved: true } } } as never)
})
afterEach(() => { vi.restoreAllMocks() })

it('marks edits dirty, saves explicitly, and keeps unknown kind values', async () => {
  const dirty = vi.fn()
  await act(async () => { render(<SnapinsSettingsTab onDirtyChange={dirty} />) })
  fireEvent.change(screen.getByLabelText('Concurrent worker limit'), { target: { value: '2' } })
  fireEvent.change(screen.getByLabelText('Claude worker prompt'), { target: { value: 'work --pass {pass}' } })
  fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'wc' } })
  expect(dirty).toHaveBeenLastCalledWith(true)
  expect(AppControl.library).not.toHaveBeenCalled()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
  expect(AppControl.library).toHaveBeenCalledWith('snapins.settings.save', { settings: { ...view.settings, limit: 2,
    workerPrompts: { claude: 'work --pass {pass}' }, kinds: { future: { value: 'keep' }, 'review-todos': { modes: { project: 'wc' } } } } })
  expect(dirty).toHaveBeenLastCalledWith(false)
})
it('discards local edits when leaving the tab', async () => {
  let mounted!: ReturnType<typeof render>
  await act(async () => { mounted = render(<SnapinsSettingsTab onDirtyChange={vi.fn()} />) })
  fireEvent.change(screen.getByLabelText('Concurrent worker limit'), { target: { value: '2' } })
  mounted.unmount()
  await act(async () => { render(<SnapinsSettingsTab onDirtyChange={vi.fn()} />) })
  expect(screen.getByLabelText('Concurrent worker limit')).toHaveValue(4)
  expect(AppControl.library).not.toHaveBeenCalled()
})
it('keeps a refused save dirty and displays its reason', async () => {
  vi.mocked(AppControl.library).mockResolvedValueOnce({ ok: true, value: { ok: false, code: 'invalid-settings', detail: 'Limit must be 1 to 32' } } as never)
  const dirty = vi.fn()
  await act(async () => { render(<SnapinsSettingsTab onDirtyChange={dirty} />) })
  fireEvent.change(screen.getByLabelText('Concurrent worker limit'), { target: { value: '0' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
  expect(screen.getByRole('alert')).toHaveTextContent('Limit must be 1 to 32')
  expect(dirty).toHaveBeenLastCalledWith(true)
})
