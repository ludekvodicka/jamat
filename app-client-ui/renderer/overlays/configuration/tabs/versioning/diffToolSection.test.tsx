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
    await waitFor(() => expect(screen.getByLabelText('Executable')).toBeEnabled())
    fireEvent.change(screen.getByLabelText('Executable'), { target: { value: 'diff tool' } })
    fireEvent.change(screen.getByLabelText('Arguments'), { target: { value: '$1' } })
    expect(screen.getByText('Save')).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent('Enter arguments containing $1 and $2')
    fireEvent.click(screen.getByText('TortoiseMerge preset'))
    expect(screen.getByLabelText('Executable')).toHaveValue('C:\\Program Files\\TortoiseSVN\\bin\\TortoiseMerge.exe')
    expect(screen.getByLabelText('Arguments')).toHaveValue('/base:"$1" /mine:"$2"')
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(dirty).toHaveBeenLastCalledWith(false))
    expect(saveSettings).toHaveBeenCalledWith({ ...VersioningSettings.defaultValue(), diffTool: VersioningSettings.tortoiseMerge() }, 'diffTool')
    fireEvent.change(screen.getByLabelText('Executable'), { target: { value: '' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(saveSettings).toHaveBeenLastCalledWith(VersioningSettings.defaultValue(), 'diffTool'))
  })
})
