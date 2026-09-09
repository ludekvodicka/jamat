import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  CatalogCategoryDto,
} from '../../../../../../lib-orchestrator/projectManager/projectManagerApi.types'
import type { AppClientUiBridge } from '../../../../../shared/appClientUiIpc'
import { ProjectsSettingsTab } from './projectsSettingsTab'

describe('app-client-ui/renderer/overlays/configuration/tabs/projects/projectsSettingsTab', () => {
  function roots(): CatalogCategoryDto[] {
    return [
      {
        id: 'nodejs',
        label: 'NodeJs',
        path: 'C:/Projects/NodeJs',
        futureCategoryKey: 'kept',
      },
      { id: 'web', label: 'Web', path: 'C:/Projects/Web' },
    ]
  }

  class BridgeStub {
    readonly saved: CatalogCategoryDto[][] = []
    private saveAnswer: unknown = { ok: true, value: { ok: true, value: undefined } }
    private pickAnswer: unknown = { ok: true, value: null }

    install(): void {
      const bridge = {
        projects: {
          getConfig: () => Promise.resolve({ ok: true, value: { ok: true, value: roots() } }),
          saveConfig: (candidate: CatalogCategoryDto[]) => {
            this.saved.push(candidate)
            return Promise.resolve(this.saveAnswer)
          },
        },
        dialog: { pickDirectory: () => Promise.resolve(this.pickAnswer) },
      }
      ;(window as unknown as { appClient: unknown }).appClient = bridge as unknown as
        Pick<AppClientUiBridge, 'projects' | 'dialog'>
    }

    refusesSaveWith(code: string, detail: string): this {
      this.saveAnswer = { ok: true, value: { ok: false, code, detail } }
      return this
    }

    picks(path: string): this {
      this.pickAnswer = { ok: true, value: { path } }
      return this
    }
  }

  afterEach(() => {
    cleanup()
    delete (window as unknown as { appClient?: unknown }).appClient
  })

  async function mount(stub = new BridgeStub()) {
    stub.install()
    const onDirtyChange = vi.fn()
    const view = render(<ProjectsSettingsTab onDirtyChange={onDirtyChange} />)
    await waitFor(() =>
      expect(view.container.querySelector('.jamat-configuration-projects__row')).toBeTruthy())
    return { stub, view, onDirtyChange }
  }

  function labels(container: HTMLElement): string[] {
    return [...container.querySelectorAll<HTMLInputElement>('.jamat-configuration-projects__label')]
      .map((input) => input.value)
  }

  function buttonNamed(container: HTMLElement, label: string): HTMLButtonElement {
    const found = [...container.querySelectorAll('button')]
      .find((node) => node.textContent === label || node.getAttribute('aria-label') === label)
    if (!found)
      throw new Error(`The tab drew no ${label} button`)
    return found
  }

  function rename(container: HTMLElement, index: number, value: string): void {
    const inputs = container.querySelectorAll<HTMLInputElement>('.jamat-configuration-projects__label')
    fireEvent.change(inputs[index], { target: { value } })
  }

  it('draws the roots the catalog answered with, in the order the file holds them', async () => {
    const { view } = await mount()

    expect(labels(view.container)).toEqual(['NodeJs', 'Web'])
    expect([...view.container.querySelectorAll('.jamat-configuration-projects__path')]
      .map((node) => node.textContent))
      .toEqual(['C:/Projects/NodeJs', 'C:/Projects/Web'])
  })

  /** The one fact the window is told, and it has to travel in both directions. */
  it('reports the first edit upward, and reports it back when the edit is undone', async () => {
    const { view, onDirtyChange } = await mount()
    expect(onDirtyChange).not.toHaveBeenCalled()

    rename(view.container, 0, 'Node')
    expect(onDirtyChange.mock.calls).toEqual([[true]])

    // A second keystroke is still one unsaved tab: the window is told when it changes, not per key.
    rename(view.container, 0, 'Node projects')
    expect(onDirtyChange.mock.calls).toEqual([[true]])

    rename(view.container, 0, 'NodeJs')
    expect(onDirtyChange.mock.calls).toEqual([[true], [false]])
  })

  it('saves nothing until there is something to save', async () => {
    const { view, stub } = await mount()

    expect(buttonNamed(view.container, 'Save').disabled).toBe(true)

    rename(view.container, 1, 'Web projects')
    expect(buttonNamed(view.container, 'Save').disabled).toBe(false)
    fireEvent.click(buttonNamed(view.container, 'Save'))

    await waitFor(() => expect(stub.saved).toHaveLength(1))
    expect(stub.saved[0]).toEqual([
      {
        id: 'nodejs',
        label: 'NodeJs',
        path: 'C:/Projects/NodeJs',
        futureCategoryKey: 'kept',
      },
      { id: 'web', label: 'Web projects', path: 'C:/Projects/Web' },
    ])
  })

  it('reports itself clean again once the save lands', async () => {
    const { view, onDirtyChange } = await mount()
    rename(view.container, 1, 'Web projects')

    fireEvent.click(buttonNamed(view.container, 'Save'))

    await waitFor(() => expect(onDirtyChange.mock.calls).toEqual([[true], [false]]))
    expect(buttonNamed(view.container, 'Save').disabled).toBe(true)
  })

  /**
   * R9. The store wrote nothing, so the edit is all there is left of the user's work - and the
   * reason it refused is the store's own sentence, not a sentence this tab made up.
   */
  it('keeps the edit and shows what the store said when the save is refused', async () => {
    const stub = new BridgeStub().refusesSaveWith(
      'catalog-latched',
      'Catalog at Q:/config.json is unreadable; nothing is written until it is repaired',
    )
    const { view, onDirtyChange } = await mount(stub)
    rename(view.container, 1, 'Web projects')

    fireEvent.click(buttonNamed(view.container, 'Save'))

    await waitFor(() => expect(view.container.querySelector('[role="alert"]')).toBeTruthy())
    expect(view.container.querySelector('[role="alert"]')?.textContent)
      .toContain('catalog-latched: Catalog at Q:/config.json is unreadable')
    expect(labels(view.container)).toEqual(['NodeJs', 'Web projects'])
    expect(onDirtyChange.mock.calls).toEqual([[true]])
  })

  it('adds a root through the native picker, naming it after the directory', async () => {
    const { view } = await mount(new BridgeStub().picks('C:/Projects/Ai'))

    fireEvent.click(buttonNamed(view.container, 'Add root…'))

    await waitFor(() => expect(labels(view.container)).toHaveLength(3))
    expect(labels(view.container)[2]).toBe('Ai')
    expect([...view.container.querySelectorAll('.jamat-configuration-projects__path')]
      .map((node) => node.textContent)[2])
      .toBe('C:/Projects/Ai')
  })

  it('adds nothing when the picker was cancelled', async () => {
    const { view, onDirtyChange } = await mount()

    fireEvent.click(buttonNamed(view.container, 'Add root…'))

    await waitFor(() => expect(onDirtyChange).not.toHaveBeenCalled())
    expect(labels(view.container)).toEqual(['NodeJs', 'Web'])
  })

  it('moves a root and refuses to move the ones at the ends', async () => {
    const { view } = await mount()

    expect(buttonNamed(view.container, 'Move NodeJs up').disabled).toBe(true)
    expect(buttonNamed(view.container, 'Move Web down').disabled).toBe(true)

    fireEvent.click(buttonNamed(view.container, 'Move Web up'))

    expect(labels(view.container)).toEqual(['Web', 'NodeJs'])
  })

  // Nothing on disk is deleted, and everything bound to the id is orphaned: the tab says so before
  // the row goes, not after.
  it('asks before a root leaves, naming what stops resolving', async () => {
    const { view } = await mount()

    fireEvent.click(buttonNamed(view.container, 'Remove Web'))

    const ask = view.container.querySelector('[role="alertdialog"]')
    expect(ask?.textContent).toContain('deletes nothing on disk')
    expect(ask?.textContent).toContain('web')
    expect(labels(view.container)).toEqual(['NodeJs', 'Web'])

    fireEvent.click(buttonNamed(view.container, 'Keep editing'))
    expect(view.container.querySelector('[role="alertdialog"]')).toBeNull()
    expect(labels(view.container)).toEqual(['NodeJs', 'Web'])
  })

  /**
   * The one button on this screen that can lose an edit without writing anything, so it is the one
   * that has to say so first. Leaving the group asks; this had to as well.
   */
  it('asks before reading the file back over unsaved edits, and reads it back when told to', async () => {
    const { view, onDirtyChange } = await mount()
    rename(view.container, 0, 'Node')

    fireEvent.click(buttonNamed(view.container, 'Reload'))
    expect(view.container.querySelector('[role="alertdialog"]')?.textContent)
      .toContain('takes every change on this screen away')
    expect(labels(view.container)).toEqual(['Node', 'Web'])

    fireEvent.click(buttonNamed(view.container, 'Discard and reload'))

    await waitFor(() => expect(labels(view.container))
      .toEqual(['NodeJs', 'Web']))
    expect(onDirtyChange.mock.calls).toEqual([[true], [false]])
  })

  it('reads the file back without a word when there is nothing to lose', async () => {
    const { view } = await mount()

    fireEvent.click(buttonNamed(view.container, 'Reload'))

    expect(view.container.querySelector('[role="alertdialog"]')).toBeNull()
    await waitFor(() => expect(labels(view.container))
      .toEqual(['NodeJs', 'Web']))
  })

  it('takes the root out of the buffer once the question is answered', async () => {
    const { view, onDirtyChange } = await mount()

    fireEvent.click(buttonNamed(view.container, 'Remove Web'))
    fireEvent.click(buttonNamed(view.container, 'Remove root'))

    expect(labels(view.container)).toEqual(['NodeJs'])
    expect(onDirtyChange.mock.calls).toEqual([[true]])
  })

  it('says why the list is empty rather than drawing nothing', async () => {
    const stub = new BridgeStub()
    stub.install()
    ;(window as unknown as { appClient: { projects: { getConfig(): unknown } } }).appClient.projects
      .getConfig = () => Promise.resolve({ ok: true, value: { ok: true, value: [] } })

    const view = render(<ProjectsSettingsTab onDirtyChange={vi.fn()} />)

    await waitFor(() =>
      expect(view.container.querySelector('.jamat-configuration-projects__note')?.textContent)
        .toContain('No roots yet'))
  })

  describe('virtual folders', () => {
    function openFolders(container: HTMLElement, label: string): void {
      fireEvent.click([...container.querySelectorAll('button')]
        .filter((node) => node.className.includes('folders-toggle'))[label === 'nodejs' ? 0 : 1])
    }

    function folderInputs(container: HTMLElement): { prefixes: string[]; titles: string[] } {
      const read = (selector: string): string[] =>
        [...container.querySelectorAll<HTMLInputElement>(selector)].map((input) => input.value)
      return {
        prefixes: read('.jamat-configuration-projects__prefix'),
        titles: read('.jamat-configuration-projects__folder-title'),
      }
    }

    it('counts the folders of each root without being opened', async () => {
      const { view } = await mount()

      expect([...view.container.querySelectorAll('button')]
        .filter((node) => node.className.includes('folders-toggle'))
        .map((node) => node.textContent))
        .toEqual(['▸ Virtual folders (0)', '▸ Virtual folders (0)'])
      expect(folderInputs(view.container).prefixes).toEqual([])
    })

    it('adds a folder to one root, fills it in and saves every root', async () => {
      const { stub, view } = await mount()
      openFolders(view.container, 'nodejs')

      fireEvent.click(buttonNamed(view.container, 'Add folder to NodeJs'))
      const prefix = view.container
        .querySelector<HTMLInputElement>('.jamat-configuration-projects__prefix')
      const title = view.container
        .querySelector<HTMLInputElement>('.jamat-configuration-projects__folder-title')
      if (!prefix || !title)
        throw new Error('The folder block drew no inputs')
      fireEvent.change(prefix, { target: { value: 'house' } })
      fireEvent.change(title, { target: { value: 'House projects' } })
      fireEvent.click(buttonNamed(view.container, 'Save'))

      await waitFor(() => expect(stub.saved).toHaveLength(1))
      expect(stub.saved[0][0].virtualFolders)
        .toEqual([{ prefix: 'house', title: 'House projects' }])
      // The other root and every key no build knows survive the save untouched.
      expect('virtualFolders' in stub.saved[0][1]).toBe(false)
      expect(stub.saved[0][0]['futureCategoryKey']).toBe('kept')
    })

    // The store refuses a folder without both halves, so Save must not offer to send it one.
    it('will not save while a folder is missing a half, and says which one', async () => {
      const { stub, view } = await mount()
      openFolders(view.container, 'web')
      fireEvent.click(buttonNamed(view.container, 'Add folder to Web'))

      expect(buttonNamed(view.container, 'Save').disabled).toBe(true)
      expect(view.container.querySelector('.jamat-configuration-projects__warn')?.textContent)
        .toContain('cannot be saved')

      const inputs = folderInputs(view.container)
      expect(inputs.prefixes).toEqual([''])
      expect(inputs.titles).toEqual([''])

      fireEvent.change(
        view.container.querySelector<HTMLInputElement>('.jamat-configuration-projects__prefix')!,
        { target: { value: 'house' } },
      )
      fireEvent.change(
        view.container.querySelector<HTMLInputElement>('.jamat-configuration-projects__folder-title')!,
        { target: { value: 'House' } },
      )

      expect(buttonNamed(view.container, 'Save').disabled).toBe(false)
      expect(stub.saved).toEqual([])
    })

    it('removes a folder without asking, because nothing on disk changes', async () => {
      const { stub, view } = await mount()
      openFolders(view.container, 'nodejs')
      fireEvent.click(buttonNamed(view.container, 'Add folder to NodeJs'))
      fireEvent.change(
        view.container.querySelector<HTMLInputElement>('.jamat-configuration-projects__prefix')!,
        { target: { value: 'house' } },
      )
      fireEvent.change(
        view.container.querySelector<HTMLInputElement>('.jamat-configuration-projects__folder-title')!,
        { target: { value: 'House' } },
      )

      fireEvent.click(buttonNamed(view.container, 'Remove folder 1 from NodeJs'))

      expect(view.container.querySelector('[role="alertdialog"]')).toBeNull()
      expect(folderInputs(view.container).prefixes).toEqual([])
      expect(buttonNamed(view.container, 'Save').disabled).toBe(true)
      expect(stub.saved).toEqual([])
    })

    it('leaves the root names alone while folder names are edited', async () => {
      const { view } = await mount()
      openFolders(view.container, 'nodejs')
      fireEvent.click(buttonNamed(view.container, 'Add folder to NodeJs'))
      fireEvent.change(
        view.container.querySelector<HTMLInputElement>('.jamat-configuration-projects__folder-title')!,
        { target: { value: 'House projects' } },
      )

      expect(labels(view.container)).toEqual(['NodeJs', 'Web'])
    })
  })

  // A read that failed leaves a tab with nothing in it, and Reload is the only way back. It stays
  // enabled with no document precisely so it can be that retry.
  it('shows a catalog that could not be read, and can be asked to read it again', async () => {
    const stub = new BridgeStub()
    stub.install()
    const projects = (window as unknown as {
      appClient: { projects: { getConfig(): unknown } }
    }).appClient.projects
    projects.getConfig = () => Promise.resolve({ ok: false, error: 'main process is gone' })

    const view = render(<ProjectsSettingsTab onDirtyChange={vi.fn()} />)

    await waitFor(() => expect(view.container.querySelector('[role="alert"]')?.textContent)
      .toContain('The main process did not answer: main process is gone'))
    expect(view.container.querySelector('.jamat-configuration-projects__row')).toBeNull()

    projects.getConfig = () => Promise.resolve({ ok: true, value: { ok: true, value: roots() } })
    fireEvent.click(buttonNamed(view.container, 'Reload'))

    await waitFor(() => expect(labels(view.container))
      .toEqual(['NodeJs', 'Web']))
  })
})
