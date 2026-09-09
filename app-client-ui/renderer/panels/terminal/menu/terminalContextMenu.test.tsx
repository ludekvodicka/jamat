import { act, cleanup, fireEvent, render, type RenderResult } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  FileViewerDocument,
  FileViewerLocation,
  FileViewerOpenResult,
} from '../../../../../lib-orchestrator/fileViewer/fileViewerApi.types'
import type {
  TerminalDetection,
  TerminalDetectResult,
  TerminalDirectoryOpenResult,
  TerminalExternalOpenResult,
} from '../../../../../lib-orchestrator/terminalDetector/terminalDetectorApi.types'
import type { AppClientUiBridge, IpcResult } from '../../../../shared/appClientUiIpc'
import { TerminalContextMenu, TerminalMenuItems } from './terminalContextMenu'
import type { TerminalMenuContext } from '../attach/useTerminalAttachment'

/** What the main process answers an accepted open with, and what the shell is then handed. */
const documentConst: FileViewerDocument = {
  documentId: 'document-1',
  documentKey: 'key-1',
  source: { kind: 'detected', sessionId: 'session-1', path: 'D:\\notes\\report.md' },
  path: 'D:\\notes\\report.md',
  name: 'report.md',
  size: 12,
  contentVersion: null,
  kind: { kind: 'markdown', flavor: 'markdown' },
  modes: ['rendered'],
}

function fileDetection(over: Partial<Extract<TerminalDetection, { kind: 'file' }>> = {}) {
  return {
    kind: 'file' as const,
    detectionId: 'detection-file',
    path: 'D:\\notes\\report.md',
    name: 'report.md',
    line: 12,
    column: null,
    via: 'direct' as const,
    opensExternally: false,
    ...over,
  }
}

function directoryDetection(
  children: number,
  truncated: boolean,
  over: Partial<Extract<TerminalDetection, { kind: 'directory' }>> = {},
): Extract<TerminalDetection, { kind: 'directory' }> {
  return {
    kind: 'directory',
    detectionId: 'detection-directory',
    path: 'D:\\notes',
    name: 'notes',
    via: 'direct',
    children: Array.from({ length: children }, (_, index) => ({
      detectionId: `child-${index}`,
      name: `file-${index}.md`,
      opensExternally: false,
    })),
    childrenTruncated: truncated,
    ...over,
  }
}

/** Every channel the menu can reach, and what each one answered. */
class MenuBridgeStub {
  readonly calls: { method: string; args: unknown[] }[] = []
  openFileAnswer: IpcResult<FileViewerOpenResult> = {
    ok: true,
    value: { ok: true, value: documentConst },
  }

  openDirectoryAnswer: IpcResult<TerminalDirectoryOpenResult> = {
    ok: true,
    value: { ok: true, value: { sessionId: 'session-1', path: 'D:\\notes', directoryKey: 'dir-1' } },
  }

  openExternalAnswer: IpcResult<TerminalExternalOpenResult> = { ok: true, value: { ok: true } }

  install(): void {
    const record = (method: string) => (...args: unknown[]) => {
      this.calls.push({ method, args })
      return Promise.resolve({ ok: true as const, value: true })
    }
    const bridge = {
      terminalMenu: {
        openFile: (requestId: string, detectionId: string) => {
          this.calls.push({ method: 'openFile', args: [requestId, detectionId] })
          return Promise.resolve(this.openFileAnswer)
        },
        openDirectory: (requestId: string, detectionId: string) => {
          this.calls.push({ method: 'openDirectory', args: [requestId, detectionId] })
          return Promise.resolve(this.openDirectoryAnswer)
        },
        openExternal: (requestId: string, detectionId: string) => {
          this.calls.push({ method: 'openExternal', args: [requestId, detectionId] })
          return Promise.resolve(this.openExternalAnswer)
        },
        openVsCode: record('openVsCode'),
        openProjectVsCode: record('openProjectVsCode'),
      },
      clipboard: { writeText: record('writeText') },
      fileViewer: { openExternal: record('openExternal'), release: record('release') },
    }
    ;(window as unknown as { appClient: AppClientUiBridge })
      .appClient = bridge as unknown as AppClientUiBridge
  }

  methods(): string[] {
    return this.calls.map((call) => call.method)
  }
}

/** The menu as it is read on screen: the top level only, since a submenu carries the same classes. */
class MenuView {
  static items(): HTMLElement[] {
    return [...document.querySelectorAll(
      '.jamat-context-menu > .jamat-context-menu__row > .jamat-context-menu__item',
    )].filter((item): item is HTMLElement => item instanceof HTMLElement)
  }

  static labels(): string[] {
    return MenuView.items().map((item) =>
      item.querySelector('.jamat-context-menu__label')?.textContent ?? '')
  }

  static layout(): string[] {
    const menu = document.querySelector('[role="menu"][aria-label="Terminal actions"]')
    if (menu === null) throw new Error('The terminal menu is not open')
    return [...menu.children].map((entry) => entry.getAttribute('role') === 'separator'
      ? 'separator'
      : entry.querySelector('.jamat-context-menu__label')?.textContent ?? '')
  }

  static itemLabelled(label: string): HTMLElement {
    const index = MenuView.labels().indexOf(label)
    if (index < 0)
      throw new Error(`The menu shows no item labelled ${JSON.stringify(label)}`)
    return MenuView.items()[index]
  }

  /** Opens the submenu under `label` and answers with what it holds, in order. */
  static submenuOf(label: string): string[] {
    fireEvent.mouseEnter(MenuView.itemLabelled(label).parentElement as HTMLElement)
    const flyout = document.querySelector('.jamat-context-menu__flyout')
    if (flyout === null) throw new Error(`The submenu under ${JSON.stringify(label)} did not open`)
    return [...flyout.querySelectorAll('.jamat-context-menu__label')]
      .map((item) => item.textContent ?? '')
  }

  static clickInSubmenu(parent: string, label: string): void {
    fireEvent.mouseEnter(MenuView.itemLabelled(parent).parentElement as HTMLElement)
    const found = [...document.querySelectorAll('.jamat-context-menu__flyout .jamat-context-menu__item')]
      .find((item) => item.querySelector('.jamat-context-menu__label')?.textContent === label)
    if (found === undefined)
      throw new Error(`The submenu under ${JSON.stringify(parent)} holds no ${JSON.stringify(label)}`)
    fireEvent.click(found)
  }

  static isOpen(): boolean {
    return document.querySelector('.jamat-context-menu') !== null
  }
}

describe('app-client-ui/renderer/panels/terminal/terminalContextMenu', () => {
  type LocalTerminalMenuContext = Extract<TerminalMenuContext, { kind: 'local' }>

  let bridge: MenuBridgeStub
  let resolveDetect: ((answer: IpcResult<TerminalDetectResult>) => void) | null = null
  let rejectDetect: ((reason: unknown) => void) | null = null
  let documentCalls: string[] = []
  let opened: { document: FileViewerDocument; location?: FileViewerLocation }[] = []
  let splitRefusal: string | null = null
  let directories: { sessionId: string; path: string; directoryKey: string }[] = []
  let closes = 0

  function contextOf(over: Partial<LocalTerminalMenuContext> = {}): LocalTerminalMenuContext {
    return {
      kind: 'local',
      clickId: 'click-1',
      position: { x: 10, y: 20 },
      hasSelection: false,
      paste: () => { documentCalls.push('paste') },
      pasteAsText: () => { documentCalls.push('pasteAsText') },
      copySelection: () => { documentCalls.push('copy') },
      detect: () => new Promise((resolve, reject) => { resolveDetect = resolve; rejectDetect = reject }),
      ...over,
    }
  }

  /** What the panel would draw. It reached `console.error` alone before, where nobody reads it. */
  let refusals: string[] = []

  function renderMenu(over: Partial<LocalTerminalMenuContext> = {}): RenderResult {
    return render(
      <TerminalContextMenu
        context={contextOf(over)}
        sessionId="session-1"
        openInSplit={(document, location) => {
          opened.push({ document, location })
          return splitRefusal
        }}
        openDirectoryAt={(sessionId, path, directoryKey) =>
          directories.push({ sessionId, path, directoryKey })}
        onRefused={(reason) => { refusals.push(reason) }}
        onClose={() => { closes += 1 }}
      />,
    )
  }

  /** The one promise the menu has, answered after it is already on screen. */
  async function land(detections: readonly TerminalDetection[]): Promise<void> {
    await act(async () => {
      resolveDetect?.({ ok: true, value: { requestId: 'request-1', detections } })
      await Promise.resolve()
    })
  }

  /** The opening rows the answer brought: everything above the project action. */
  function openingLabels(): string[] {
    const labels = MenuView.labels()
    return labels.slice(0, labels.indexOf('Open project in VS Code'))
  }

  async function flush(): Promise<void> {
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  beforeEach(() => {
    resolveDetect = null
    rejectDetect = null
    documentCalls = []
    opened = []
    splitRefusal = null
    directories = []
    refusals = []
    closes = 0
    bridge = new MenuBridgeStub()
    bridge.install()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    delete (window as unknown as { appClient?: unknown }).appClient
  })

  it('draws the final action order after the detections land', async () => {
    renderMenu()

    expect(MenuView.labels()).toEqual(['Loading…'])

    await land([fileDetection()])

    expect(MenuView.layout()).toEqual([
      'Open report.md:12',
      'Open report.md in VS Code',
      'Open project in VS Code',
      'separator',
      'Copy report.md path',
      'separator',
      'Paste as text',
      'Paste',
    ])
  })

  /**
   * The detections belong above every action. Until the answer lands, a single explicit pending row
   * prevents an actionable item from moving out from under the pointer.
   */
  describe('while the detections are still out', () => {
    function disabled(): string[] {
      return MenuView.items().filter((item) => item.hasAttribute('disabled'))
        .map((item) => item.querySelector('.jamat-context-menu__label')?.textContent ?? '')
    }

    it('shows no action before the final layout is known', async () => {
      renderMenu({ hasSelection: true })

      expect(MenuView.labels()).toEqual(['Loading…'])
      expect(disabled()).toEqual(['Loading…'])

      await land([fileDetection()])

      expect(disabled()).toEqual([])
    })

    // A refusal still replaces the pending row with the actions that need no detection.
    it('settles a refusal into the always-available actions', async () => {
      const reported = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      renderMenu()

      await act(async () => {
        resolveDetect?.({ ok: false, error: 'the attach is gone' })
        await Promise.resolve()
      })

      expect(disabled()).toEqual([])
      expect(MenuView.labels()).toEqual(['Open project in VS Code', 'Paste as text', 'Paste'])
      expect(reported).toHaveBeenCalledWith('[app-client-ui] the attach is gone')
    })

    /**
     * The channel failing is not the handler refusing: a torn-down frame or a handler that is not
     * there rejects the invoke itself. Without an arm for that the rejection is unhandled and the
     * menu waits for an answer that can no longer come.
     */
    it('settles when the channel itself fails, rather than waiting for an answer', async () => {
      const reported = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      renderMenu()

      await act(async () => {
        rejectDetect?.(new Error('the frame was torn down'))
        await Promise.resolve()
      })

      expect(MenuView.labels()).toEqual(['Open project in VS Code', 'Paste as text', 'Paste'])
      expect(reported).toHaveBeenCalledWith('[app-client-ui] the frame was torn down')
    })
  })

  it('offers Copy only while something is selected', async () => {
    renderMenu()
    await land([])
    expect(MenuView.labels()).not.toContain('Copy')

    cleanup()
    renderMenu({ hasSelection: true })
    await land([])

    expect(MenuView.labels()).toContain('Copy')
    fireEvent.click(MenuView.itemLabelled('Copy'))
    fireEvent.click(MenuView.itemLabelled('Paste as text'))
    fireEvent.click(MenuView.itemLabelled('Paste'))
    expect(documentCalls).toEqual(['copy', 'pasteAsText', 'paste'])
    await flush()
  })

  it('spells the line a detection carried, and leaves it out where there is none', async () => {
    renderMenu()

    await land([
      fileDetection(),
      fileDetection({ detectionId: 'detection-plain', name: 'notes.md', line: null }),
    ])

    expect(MenuView.labels()).toContain('Open report.md:12')
    expect(MenuView.labels()).toContain('Open notes.md')
  })

  /**
   * A PDF has no reading in this viewer at all - it opens as a hex dump - so the row that would draw
   * one is replaced rather than joined by a second. The other two rows are untouched: VS Code and
   * Copy path mean the same thing whatever the file is.
   */
  it('offers the desktop for a pdf instead of a viewer tab, and opens it through the detection', async () => {
    renderMenu()

    await land([fileDetection({
      name: 'report.pdf',
      path: 'D:\\notes\\report.pdf',
      line: null,
      opensExternally: true,
    })])

    expect(MenuView.layout()).toEqual([
      'Open report.pdf in external viewer',
      'Open report.pdf in VS Code',
      'Open project in VS Code',
      'separator',
      'Copy report.pdf path',
      'separator',
      'Paste as text',
      'Paste',
    ])

    fireEvent.click(MenuView.itemLabelled('Open report.pdf in external viewer'))
    await flush()

    expect(bridge.calls).toEqual([{ method: 'openExternal', args: ['request-1', 'detection-file'] }])
    expect(opened).toEqual([])
  })

  it('says why the desktop refused a pdf, and opens nothing in its place', async () => {
    const reported = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    bridge.openExternalAnswer = {
      ok: true,
      value: { ok: false, code: 'failed', detail: 'no reader is associated with this file' },
    }
    renderMenu()
    await land([fileDetection({ name: 'report.pdf', line: null, opensExternally: true })])

    fireEvent.click(MenuView.itemLabelled('Open report.pdf in external viewer'))
    await flush()

    expect(reported).toHaveBeenCalledWith(
      '[app-client-ui] failed: no reader is associated with this file',
    )
    expect(refusals).toEqual(['failed: no reader is associated with this file'])
  })

  /**
   * The children sit under one another in one submenu, so the one that goes somewhere else says so:
   * a row that opens a reader while its neighbours open tabs is the surprise nobody can see coming.
   */
  it('marks a listed child that opens outside and sends it down the same channel', async () => {
    renderMenu()

    await land([directoryDetection(2, false, {
      children: [
        { detectionId: 'child-0', name: 'a.md', opensExternally: false },
        { detectionId: 'child-1', name: 'manual.pdf', opensExternally: true },
      ],
    })])

    expect(MenuView.submenuOf('Files in notes')).toEqual(['a.md', 'manual.pdf (external viewer)'])

    fireEvent.click(MenuView.itemLabelled('Files in notes').parentElement
      ?.querySelector('.jamat-context-menu__flyout')
      ?.querySelectorAll('.jamat-context-menu__item')[1] as HTMLElement)
    await flush()

    expect(bridge.calls).toEqual([{ method: 'openExternal', args: ['request-1', 'child-1'] }])
  })

  it('lists the files inside a directory in a submenu, and says when there are more', async () => {
    renderMenu()

    await land([directoryDetection(8, true)])

    expect(MenuView.layout()).toEqual([
      'Open D:\\notes in tab',
      'Files in notes',
      'Open notes in VS Code',
      'Open project in VS Code',
      'separator',
      'Copy notes path',
      'separator',
      'Paste as text',
      'Paste',
    ])
    const children = MenuView.submenuOf('Files in notes')
    expect(children).toHaveLength(9)
    expect(children.slice(0, 8))
      .toEqual(Array.from({ length: 8 }, (_, index) => `file-${index}.md`))
    expect(children[8]).toBe('… more files')
  })

  // Nothing to list is a directory with one entry, not a submenu that opens onto nothing.
  it('offers no submenu for a directory it could not read', async () => {
    renderMenu()

    await land([directoryDetection(0, false)])

    expect(openingLabels()).toEqual([
      'Open D:\\notes in tab',
      'Open notes in VS Code',
    ])
  })

  // The label is the only thing telling this `tree` from the four other directories called `tree`
  // a session prints, so the middle goes and the root and the tail stay.
  it('names the whole path of a directory, and loses its middle when it is too long', async () => {
    renderMenu()

    await land([directoryDetection(0, false, {
      path: `Q:\\one\\two\\three\\${'deep'.repeat(12)}\\configs\\testbed\\tree`,
      name: 'tree',
    })])

    const label = openingLabels()[0] ?? ''
    expect(label.startsWith('Open Q:\\…\\')).toBe(true)
    expect(label.endsWith('\\configs\\testbed\\tree in tab')).toBe(true)
    expect(label.length).toBeLessThanOrEqual('Open  in tab'.length + 56)
  })

  it('offers the directory to VS Code and to the clipboard, the way a file is offered', async () => {
    renderMenu()
    await land([directoryDetection(0, false)])

    fireEvent.click(MenuView.itemLabelled('Open notes in VS Code'))
    await flush()
    fireEvent.click(MenuView.itemLabelled('Copy notes path'))
    await flush()

    expect(bridge.calls).toEqual([
      { method: 'openVsCode', args: ['request-1', 'detection-directory'] },
      { method: 'writeText', args: ['D:\\notes'] },
    ])
  })

  it('offers a URL it found, and shortens one too long to read', async () => {
    renderMenu()

    await land([
      { kind: 'url', detectionId: 'detection-url', url: 'https://example.com/report' },
      { kind: 'url', detectionId: 'detection-long', url: `https://example.com/${'a'.repeat(80)}` },
    ])

    expect(openingLabels()[0]).toBe('Open https://example.com/report')
    expect(openingLabels()[1]).toMatch(/^Open https:\/\/example\.com\/a+…$/)
    expect(openingLabels()[1]).toHaveLength('Open '.length + 56)

    fireEvent.click(MenuView.itemLabelled('Open https://example.com/report'))
    await flush()
    expect(bridge.calls).toEqual([
      { method: 'openExternal', args: ['https://example.com/report'] },
    ])
  })

  /**
   * The File Changes open flow's shape: the channel first, the library second, then the document goes
   * to the split and is let go of - the pane asks for a document of its own.
   */
  it('opens a file through two unwraps, hands the shell the document and releases it', async () => {
    renderMenu()
    await land([fileDetection()])

    fireEvent.click(MenuView.itemLabelled('Open report.md:12'))
    await flush()

    expect(bridge.calls).toEqual([
      { method: 'openFile', args: ['request-1', 'detection-file'] },
      { method: 'release', args: ['document-1'] },
    ])
    expect(opened).toEqual([{ document: documentConst, location: { line: 12 } }])
    expect(closes).toBe(1)
  })

  it('reports a split refusal once and still releases the handed-off document', async () => {
    splitRefusal = 'The split already has 8 open files.'
    renderMenu()
    await land([fileDetection()])

    fireEvent.click(MenuView.itemLabelled('Open report.md:12'))
    await flush()

    expect(opened).toEqual([{ document: documentConst, location: { line: 12 } }])
    expect(bridge.calls).toEqual([
      { method: 'openFile', args: ['request-1', 'detection-file'] },
      { method: 'release', args: ['document-1'] },
    ])
    expect(refusals).toEqual(['The split already has 8 open files.'])
  })

  /*
   * Twice: the console for whoever is debugging, and the panel for whoever clicked. The sentence
   * this carries is written for a person and has an instruction in it - the detection behind a menu
   * item expires, so the answer to "nothing opened" is usually "right-click it again" - and it used
   * to reach the console alone, where nobody was going to read it.
   */
  it('says why an open was refused, to the panel as well as the console, and opens nothing', async () => {
    const reported = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    bridge.openFileAnswer = {
      ok: true,
      value: { ok: false, code: 'proof-expired', detail: 'open it from the terminal again' },
    }
    renderMenu()
    await land([fileDetection()])

    fireEvent.click(MenuView.itemLabelled('Open report.md:12'))
    await flush()

    expect(opened).toEqual([])
    expect(bridge.methods()).toEqual(['openFile'])
    expect(reported).toHaveBeenCalledWith(
      '[app-client-ui] proof-expired: open it from the terminal again',
    )
    expect(refusals).toEqual(['proof-expired: open it from the terminal again'])
  })

  it('opens the directory it found, and each child through its own detection', async () => {
    renderMenu()
    await land([directoryDetection(2, false)])

    fireEvent.click(MenuView.itemLabelled('Open D:\\notes in tab'))
    await flush()

    expect(directories)
      .toEqual([{ sessionId: 'session-1', path: 'D:\\notes', directoryKey: 'dir-1' }])

    MenuView.clickInSubmenu('Files in notes', 'file-1.md')
    await flush()

    expect(bridge.calls).toEqual([
      { method: 'openDirectory', args: ['request-1', 'detection-directory'] },
      { method: 'openFile', args: ['request-1', 'child-1'] },
      { method: 'release', args: ['document-1'] },
    ])
    expect(opened).toEqual([{ document: documentConst, location: undefined }])
  })

  it('throws for an unknown detection kind', () => {
    const result = {
      requestId: 'request-1',
      detections: [{ kind: 'archive', detectionId: 'unknown' }],
    } as unknown as TerminalDetectResult
    const nothing = (): void => undefined

    expect(() => TerminalMenuItems.ofDetections(result, {
      openFile: nothing,
      openExternal: nothing,
      openDirectory: nothing,
      openVsCode: nothing,
      openProjectVsCode: nothing,
      copyPath: nothing,
      openUrl: nothing,
    })).toThrow(/Unknown terminal detection/)
  })

  it('copies the path of a detection through the clipboard channel', async () => {
    renderMenu()
    await land([fileDetection()])

    fireEvent.click(MenuView.itemLabelled('Copy report.md path'))
    await flush()

    expect(bridge.calls).toEqual([{ method: 'writeText', args: ['D:\\notes\\report.md'] }])
  })

  // The one item that never depends on a find: which project a session runs in is known before the click.
  it('offers the session project to VS Code with nothing detected at all', async () => {
    renderMenu()
    await land([])

    fireEvent.click(MenuView.itemLabelled('Open project in VS Code'))
    await flush()

    expect(bridge.calls).toEqual([{ method: 'openProjectVsCode', args: ['session-1'] }])
  })

  it('sends a file detection to VS Code by its detection, never by its path', async () => {
    renderMenu()
    await land([fileDetection()])

    fireEvent.click(MenuView.itemLabelled('Open report.md in VS Code'))
    await flush()

    expect(bridge.calls).toEqual([{ method: 'openVsCode', args: ['request-1', 'detection-file'] }])
  })

  /**
   * A menu closed before its answer landed takes the answer with it. Asserted through the refusal
   * arm, which is the one the answer can be SEEN on: React says nothing about a write into a
   * component that has gone, so a menu that read a refusal it should never have seen would report it
   * and look identical otherwise.
   */
  it('ignores an answer that arrives after it is gone, refusal included', async () => {
    const reported = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const view = renderMenu()

    view.unmount()
    await act(async () => {
      resolveDetect?.({ ok: false, error: 'the attach is gone' })
      await Promise.resolve()
    })

    expect(MenuView.isOpen()).toBe(false)
    expect(reported).not.toHaveBeenCalled()
  })
})
