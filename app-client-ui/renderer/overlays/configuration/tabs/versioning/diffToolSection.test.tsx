import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppClientUiBridge } from '../../../../../shared/appClientUiIpc'
import { VersioningSettings } from '../../../../../shared/versioningSettings'
import { DiffToolSection } from './diffToolSection'

afterEach(() => cleanup())
describe('app-client-ui/renderer/overlays/configuration/tabs/versioning/diffToolSection', () => {
  it('validates external settings, fills the preset and saves only the diff tool field', async () => {
    const saveSettings = vi.fn(async () => ({ ok: true as const, value: { ok: true as const } }))
    const bridge = { versioning: { getSettings: async () => ({ ok: true, value: VersioningSettings.defaultValue() }), saveSettings } }
    ;(window as unknown as { appClient: AppClientUiBridge }).appClient = bridge as unknown as AppClientUiBridge
    const dirty = vi.fn()
    render(<DiffToolSection onDirtyChange={dirty} />)
    await waitFor(() => expect(screen.getByRole('combobox')).toBeEnabled())
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'external' } })
    expect(screen.getByText('Save')).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent('Enter an executable')
    fireEvent.click(screen.getByText('TortoiseMerge preset'))
    expect(screen.getByLabelText('Executable')).toHaveValue('C:\\Program Files\\TortoiseSVN\\bin\\TortoiseMerge.exe')
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(dirty).toHaveBeenLastCalledWith(false))
    expect(saveSettings).toHaveBeenCalledWith({ mode: 'checkpoints', diffTool: VersioningSettings.tortoiseMerge() }, 'diffTool')
  })
})
