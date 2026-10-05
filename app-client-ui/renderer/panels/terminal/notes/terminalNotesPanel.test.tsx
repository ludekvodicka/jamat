import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AppClientUiBridge } from '../../../../shared/appClientUiIpc'
import { DirectoryNotes } from '../../../../shared/directoryNotes'
import { TerminalNotesPanel } from './terminalNotesPanel'
import type { TerminalNoteEntry } from './terminalNotesState'
import { useTerminalNotes } from './useTerminalNotes'
import type { TerminalNotesModel } from './useTerminalNotes'

describe('app-client-ui/renderer/panels/terminal/notes/terminalNotesPanel', () => {
  afterEach(() => {
    cleanup()
    delete (window as unknown as { appClient?: unknown }).appClient
  })

  function entry(id: string, text: string, flags: Partial<TerminalNoteEntry> = {}): TerminalNoteEntry {
    return { id, text, large: false, sticky: false, ...flags }
  }

  function modelOf(change: Partial<TerminalNotesModel> = {}): TerminalNotesModel {
    return {
      phase: 'ready',
      directory: 'Q:/Work/Product',
      entries: [entry('n1', 'first'), entry('n2', '')],
      error: null,
      notice: null,
      importing: false,
      focusId: null,
      add: vi.fn(),
      update: vi.fn(),
      removeOrClear: vi.fn(),
      toggleSticky: vi.fn(),
      toggleLarge: vi.fn(),
      commitNow: vi.fn(),
      paste: vi.fn(),
      importPrompt: vi.fn(() => Promise.resolve()),
      retry: vi.fn(),
      ...change,
    }
  }

  function draw(model: TerminalNotesModel, flags: { canPaste?: boolean; canImport?: boolean } = {}) {
    return render(
      <TerminalNotesPanel model={model} canPaste={flags.canPaste ?? true} canImport={flags.canImport ?? true} />,
    )
  }

  it('shows the directory on top and numbers the notes', () => {
    const view = draw(modelOf())

    expect(view.container.querySelector('.terminal-notes__scope')?.textContent).toBe('Q:/Work/Product')
    expect([...view.container.querySelectorAll('.terminal-notes__label')].map((label) => label.textContent))
      .toEqual(['#1', '#2'])
    expect(screen.getAllByRole('textbox')).toHaveLength(2)
  })

  it('enables Paste only for a live terminal and a note with text', () => {
    const model = modelOf()
    draw(model)
    const [first, second] = screen.getAllByRole('button', { name: 'Paste' })
    expect(first).toBeEnabled()
    expect(second).toBeDisabled()
    fireEvent.click(first)
    expect(model.paste).toHaveBeenCalledWith('n1')
    cleanup()

    draw(modelOf(), { canPaste: false })
    expect(screen.getAllByRole('button', { name: 'Paste' }).every((button) => (button as HTMLButtonElement).disabled))
      .toBe(true)
  })

  it('offers Import only when the session can import', () => {
    const model = modelOf()
    draw(model)
    fireEvent.click(screen.getByRole('button', { name: 'Import from prompt' }))
    expect(model.importPrompt).toHaveBeenCalledTimes(1)
    cleanup()

    draw(modelOf(), { canImport: false })
    expect(screen.queryByRole('button', { name: 'Import from prompt' })).toBeNull()
  })

  it('draws Large and Sticky as pressed toggles', () => {
    const model = modelOf({ entries: [entry('n1', 'a', { large: true }), entry('n2', 'b', { sticky: true })] })
    const view = draw(model)

    const [large1, large2] = screen.getAllByRole('button', { name: 'Large' })
    const [sticky1, sticky2] = screen.getAllByRole('button', { name: 'Sticky' })
    expect(large1).toHaveAttribute('aria-pressed', 'true')
    expect(large2).toHaveAttribute('aria-pressed', 'false')
    expect(sticky1).toHaveAttribute('aria-pressed', 'false')
    expect(sticky2).toHaveAttribute('aria-pressed', 'true')
    const [text1, text2] = view.container.querySelectorAll('textarea')
    expect(text1).toHaveClass('terminal-notes__text', 'terminal-notes__text--large')
    expect(text2).not.toHaveClass('terminal-notes__text--large')

    fireEvent.click(large2)
    fireEvent.click(sticky1)
    expect(model.toggleLarge).toHaveBeenCalledWith('n2')
    expect(model.toggleSticky).toHaveBeenCalledWith('n1')
  })

  it('names the × after what it does', () => {
    draw(modelOf())
    expect(screen.getAllByRole('button', { name: 'Remove note' })).toHaveLength(2)
    cleanup()

    const model = modelOf({ entries: [entry('n1', 'only')] })
    draw(model)
    fireEvent.click(screen.getByRole('button', { name: 'Clear note' }))
    expect(model.removeOrClear).toHaveBeenCalledWith('n1')
  })

  it('disables + Add note at the limit', () => {
    const full = Array.from({ length: DirectoryNotes.notesMaxConst }, (_, index) => entry(`n${index}`, ''))
    draw(modelOf({ entries: full }))
    expect(screen.getByRole('button', { name: '+ Add note' })).toBeDisabled()
    cleanup()

    const model = modelOf()
    draw(model)
    fireEvent.click(screen.getByRole('button', { name: '+ Add note' }))
    expect(model.add).toHaveBeenCalledTimes(1)
  })

  it('locks the editors during an import', () => {
    draw(modelOf({ importing: true }))

    expect(screen.getAllByRole('textbox').every((box) => box.hasAttribute('readonly'))).toBe(true)
    expect(screen.getByRole('button', { name: 'Importing…' })).toBeDisabled()
  })

  it('edits through the model and saves on blur', () => {
    const model = modelOf()
    draw(model)
    const [first] = screen.getAllByRole('textbox')

    fireEvent.change(first, { target: { value: 'changed' } })
    fireEvent.blur(first)

    expect(model.update).toHaveBeenCalledWith('n1', 'changed')
    expect(model.commitNow).toHaveBeenCalledTimes(1)
  })

  it('shows a failed read with Retry and no editor', () => {
    const model = modelOf({ phase: 'failed', entries: [], error: 'section damaged' })
    draw(model)

    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByText(/section damaged/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(model.retry).toHaveBeenCalledTimes(1)
  })

  it('shows a save error with Retry beside the editors, and the notice', () => {
    draw(modelOf({ error: 'Notes were not saved: locked', notice: 'Nothing in the prompt to import' }))

    expect(screen.getByText(/Notes were not saved: locked/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Nothing in the prompt to import')
    expect(screen.getAllByRole('textbox')).toHaveLength(2)
  })

  it('focuses the note the model asks for', () => {
    const view = draw(modelOf())
    view.rerender(<TerminalNotesPanel model={modelOf({ focusId: 'n2' })} canPaste canImport />)

    expect(document.activeElement).toBe(screen.getAllByRole('textbox')[1])
  })

  it('writes no inline style anywhere', () => {
    const view = draw(modelOf({ error: 'e', notice: 'n', entries: [entry('n1', 'a', { large: true, sticky: true })] }))

    expect(view.container.querySelector('[style]')).toBeNull()
  })

  it('toggles a note to Large through the real model', async () => {
    const answer = {
      ok: true,
      value: { ok: true, value: { directory: 'C:/work', notes: [{ text: 'a' }] } },
    }
    ;(window as unknown as { appClient: AppClientUiBridge }).appClient = {
      directoryNotes: {
        get: () => Promise.resolve(answer),
        save: () => Promise.resolve({ ok: true, value: { ok: true } }),
        importPrompt: () => new Promise(() => undefined),
      },
      onDirectoryNotesChanged: () => () => undefined,
    } as unknown as AppClientUiBridge
    function Harness(): React.JSX.Element {
      const model = useTerminalNotes({ sessionId: 's1', enabled: true, paste: () => true, onTaken: () => undefined })
      return <TerminalNotesPanel model={model} canPaste canImport />
    }
    const view = render(<Harness />)
    await act(async () => { await Promise.resolve() })

    fireEvent.click(screen.getByRole('button', { name: 'Large' }))

    expect(screen.getByRole('button', { name: 'Large' })).toHaveAttribute('aria-pressed', 'true')
    expect(view.container.querySelector('textarea')).toHaveClass('terminal-notes__text--large')

    fireEvent.click(screen.getByRole('button', { name: 'Import from prompt' }))
    await act(async () => { await Promise.resolve() })
    expect(view.container.querySelector('textarea')).toHaveAttribute('readonly')
  })
})
